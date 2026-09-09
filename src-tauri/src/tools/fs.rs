//! Workspace filesystem tools — the model's read/write access to one
//! directory the user picked for the current chat.
//!
//! Unlike every other built-in, these are *not* pure functions of their
//! arguments: each one is resolved against the chat's workspace root
//! (`sessions.workspace_root`), which is why [`super::builtin::Dispatch`]
//! carries a `Workspace` variant. No root on the session means the tools
//! are never even offered to the model.
//!
//! ## The sandbox
//!
//! Everything funnels through [`resolve_read`] / [`resolve_write`], which
//! are the only places a model-supplied string becomes a path. Both:
//!
//!   1. reject absolute paths, drive-qualified paths (`C:foo`), and any
//!      `..` component *before* touching the filesystem,
//!   2. canonicalize, so symlinks are resolved rather than trusted, and
//!   3. re-check the canonical result is still under the canonical root.
//!
//! Step 3 is the one that matters: a symlink inside the workspace pointing
//! at `/etc` canonicalizes to `/etc`, fails the prefix check, and is
//! refused. Step 1 alone would not catch it.
//!
//! The root itself is canonicalized once, when the user picks it
//! (`commands::pick_session_workspace`), so the prefix comparison is
//! canonical-vs-canonical on both sides — on Windows that means both
//! carry the `\\?\` verbatim prefix and `starts_with` compares whole
//! components rather than raw strings.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

use crate::mcp::McpCallResult;

pub const LIST_DIRECTORY: &str = "list_directory";
pub const READ_FILE: &str = "read_file";
pub const SEARCH_FILES: &str = "search_files";
pub const WRITE_FILE: &str = "write_file";
pub const EDIT_FILE: &str = "edit_file";

/// Single settings toggle for the whole group. The five tools are one
/// capability from the user's point of view ("let the model work in a
/// folder"), and splitting them into five switches would let someone
/// enable `write_file` while disabling `read_file` — a combination with
/// no sensible use.
///
/// Singular `_tool_enabled` despite covering five tools: that suffix is how
/// `tests/settingsAllowlist.test.ts` recognises a key as registry-owned
/// rather than one needing a hand-written `WRITABLE_SETTING_KEYS` entry.
pub const SETTING_KEY: &str = "workspace_tool_enabled";

/// Tools that mutate the workspace. These are the ones
/// [`crate::mcp::needs_approval`] parks on the consent prompt: reads are
/// bounded by the sandbox and can only surface what is already inside a
/// directory the user deliberately picked, but a write changes their
/// files, so it gets an explicit yes with the path and payload on screen.
pub fn requires_approval(name: &str) -> bool {
    matches!(name, WRITE_FILE | EDIT_FILE)
}

/// Ceiling on a single `read_file` response. Well above a normal source
/// file and well below anything that would blow the 32 KiB per-result cap
/// in `providers::MAX_TOOL_RESULT_BYTES` without the model being told —
/// hitting this limit produces an explicit "truncated" marker instead.
const MAX_READ_BYTES: usize = 256 * 1024;
/// Ceiling on a single `write_file` payload. A model emitting more than a
/// megabyte into one file is malfunctioning, not authoring.
const MAX_WRITE_BYTES: usize = 1024 * 1024;
const MAX_LIST_ENTRIES: usize = 500;
const MAX_SEARCH_MATCHES: usize = 100;
/// Files opened during one `search_files` call. Bounds the wall-clock so a
/// search can't eat the 20 s built-in timeout on a large tree.
const MAX_SEARCH_FILES: usize = 2_000;
const MAX_DEPTH: u32 = 8;
/// Bytes of a candidate file `search_files` will read. Skipping the tail of
/// a huge log beats stalling on it.
const MAX_SEARCH_FILE_BYTES: usize = 512 * 1024;

/// Directories skipped when *walking* (`list_directory`, `search_files`).
/// Reading an explicit path inside one still works — the user may well
/// want `read_file(".git/config")` — this only stops a listing from
/// drowning in dependency and build output.
const SKIPPED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".svelte-kit",
    ".cache",
    ".idea",
    ".gradle",
];

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

/// Vet the *shape* of a model-supplied relative path before it is joined
/// to anything. Returns the cleaned relative path.
///
/// Rejects absolute paths, Windows drive/root prefixes, and `..`. The `..`
/// check is not the security boundary on its own (the canonical prefix
/// check below is), but rejecting it here produces a message the model can
/// act on instead of a confusing "outside the workspace" after the fact.
fn vet_relative(rel: &str) -> Result<PathBuf, String> {
    let trimmed = rel.trim();
    if trimmed.is_empty() || trimmed == "." {
        return Ok(PathBuf::new());
    }
    let p = Path::new(trimmed);
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Normal(part) => out.push(part),
            // `./foo` is harmless — drop the segment and carry on.
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(format!(
                    "`{rel}` contains `..`. Paths must stay inside the workspace; \
                     pass a path relative to the workspace root."
                ))
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!(
                    "`{rel}` is an absolute path. Pass a path relative to the \
                     workspace root instead (e.g. `src/main.rs`)."
                ))
            }
        }
    }
    Ok(out)
}

/// Confirm `candidate` — already canonical — sits inside `root`.
fn ensure_inside(root: &Path, candidate: &Path, rel: &str) -> Result<(), String> {
    if candidate.starts_with(root) {
        return Ok(());
    }
    // Deliberately does not echo the resolved path: on a symlink escape it
    // would disclose a location outside the workspace to the model.
    Err(format!(
        "`{rel}` resolves outside the workspace (it is, or goes through, a \
         link that leaves the root). Refused."
    ))
}

/// Resolve a path that must already exist.
fn resolve_read(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let vetted = vet_relative(rel)?;
    let joined = root.join(&vetted);
    let canon = joined
        .canonicalize()
        .map_err(|e| format!("`{}` is not readable: {e}", display_rel(rel)))?;
    ensure_inside(root, &canon, rel)?;
    Ok(canon)
}

/// Resolve a path that may not exist yet, creating missing parents inside
/// the workspace.
///
/// The target itself can't be canonicalized (it may not be there), so we
/// canonicalize the deepest ancestor that *does* exist, prefix-check that,
/// and re-append the remaining components. Those components came out of
/// [`vet_relative`], so every one is `Normal` — no `..`, no root — and
/// appending them to an in-root canonical base therefore cannot leave the
/// root.
fn resolve_write(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let vetted = vet_relative(rel)?;
    if vetted.as_os_str().is_empty() {
        return Err("`path` must name a file, not the workspace root".into());
    }

    // Walk down from the root through the components that already exist.
    let mut base = root
        .canonicalize()
        .map_err(|e| format!("the workspace root is no longer readable: {e}"))?;
    let mut remaining: Vec<&std::ffi::OsStr> = Vec::new();
    let mut descending = true;
    for part in vetted.iter() {
        if descending {
            let next = base.join(part);
            match next.canonicalize() {
                Ok(canon) => {
                    // Check every step, not just the last: a symlink halfway
                    // down is the escape we care about.
                    ensure_inside(root, &canon, rel)?;
                    base = canon;
                    continue;
                }
                Err(_) => descending = false,
            }
        }
        remaining.push(part);
    }

    if remaining.is_empty() {
        // Every component existed — `base` is the canonical target. Refuse
        // to write through a symlink even though it stayed inside the root:
        // the user picked a directory, not whatever else that link aliases.
        let meta = base
            .symlink_metadata()
            .map_err(|e| format!("`{}` is not writable: {e}", display_rel(rel)))?;
        if meta.is_dir() {
            return Err(format!(
                "`{}` is a directory, not a file",
                display_rel(rel)
            ));
        }
        return Ok(base);
    }

    let mut target = base;
    for part in &remaining {
        target.push(part);
    }
    Ok(target)
}

/// Normalise a path for messages so Windows and POSIX read the same.
fn display_rel(rel: &str) -> String {
    rel.replace('\\', "/")
}

/// Path of `p` relative to `root`, in forward-slash form. Used for every
/// path we hand back to the model so it never learns where the workspace
/// sits on disk.
fn rel_display(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

pub fn list_directory_description() -> &'static str {
    "List files and subdirectories inside the chat's workspace directory. \
     Paths are relative to the workspace root; use `.` for the root itself. \
     Start here to find out what the project contains before reading files. \
     Dependency and build directories (node_modules, target, dist, .git, …) \
     are skipped."
}

pub fn list_directory_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Directory to list, relative to the workspace root. Defaults to `.` (the root)."
            },
            "depth": {
                "type": "integer",
                "description": "How many levels to descend. 1 lists only the directory's own entries. Default 2, maximum 8."
            }
        },
        "additionalProperties": false
    })
}

pub fn read_file_description() -> &'static str {
    "Read a text file from the chat's workspace directory. Returns the \
     contents with 1-based line numbers prefixed, so you can refer to and \
     edit exact lines afterwards. The path is relative to the workspace \
     root. Use `start_line` / `max_lines` to page through a long file \
     rather than asking for all of it."
}

pub fn read_file_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "File to read, relative to the workspace root (e.g. `src/main.rs`)."
            },
            "start_line": {
                "type": "integer",
                "description": "1-based line to start at. Default 1."
            },
            "max_lines": {
                "type": "integer",
                "description": "How many lines to return. Default: the whole file, up to the size limit."
            }
        },
        "required": ["path"],
        "additionalProperties": false
    })
}

pub fn search_files_description() -> &'static str {
    "Search file contents inside the chat's workspace directory with a \
     regular expression, returning matching lines with their file paths and \
     line numbers. This is the fastest way to locate a symbol, string, or \
     definition — prefer it over reading files one by one. Dependency and \
     build directories are skipped, and binary files are ignored."
}

pub fn search_files_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string",
                "description": "Regular expression to search for (Rust regex syntax, which is the same as PCRE for ordinary patterns)."
            },
            "path": {
                "type": "string",
                "description": "Subdirectory to search, relative to the workspace root. Defaults to the whole workspace."
            },
            "extensions": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Restrict to these file extensions, without the dot (e.g. [\"rs\", \"toml\"]). Default: all text files."
            },
            "case_sensitive": {
                "type": "boolean",
                "description": "Default false."
            }
        },
        "required": ["pattern"],
        "additionalProperties": false
    })
}

pub fn write_file_description() -> &'static str {
    "Create a file, or replace an existing file's entire contents, inside \
     the chat's workspace directory. Missing parent directories are created. \
     The user is asked to approve every write before it happens. To change \
     part of a file, prefer `edit_file` — it is far cheaper than rewriting \
     the whole thing and cannot accidentally drop content you did not read."
}

pub fn write_file_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "File to write, relative to the workspace root."
            },
            "content": {
                "type": "string",
                "description": "The complete new contents of the file."
            }
        },
        "required": ["path", "content"],
        "additionalProperties": false
    })
}

pub fn edit_file_description() -> &'static str {
    "Replace an exact snippet of text in a file inside the chat's workspace \
     directory. Read the file first so `old_text` matches byte for byte, \
     including indentation. `old_text` must occur exactly once unless \
     `replace_all` is true — an ambiguous edit is refused rather than \
     guessed at. The user is asked to approve every edit before it happens."
}

pub fn edit_file_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "File to edit, relative to the workspace root."
            },
            "old_text": {
                "type": "string",
                "description": "Exact text to replace, copied from the file including whitespace."
            },
            "new_text": {
                "type": "string",
                "description": "Text to put in its place. Use an empty string to delete."
            },
            "replace_all": {
                "type": "boolean",
                "description": "Replace every occurrence instead of requiring exactly one. Default false."
            }
        },
        "required": ["path", "old_text", "new_text"],
        "additionalProperties": false
    })
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

pub fn dispatch_list_directory(root: &Path, args: &Value) -> McpCallResult {
    let rel = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
    let depth = super::lenient_i64(args, "depth").unwrap_or(2).clamp(1, MAX_DEPTH as i64) as u32;

    let dir = match resolve_read(root, rel) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    if !dir.is_dir() {
        return err(format!("`{}` is not a directory", display_rel(rel)));
    }

    let mut out = String::new();
    let mut count = 0usize;
    let truncated = walk_listing(root, &dir, depth, 0, &mut out, &mut count);

    if out.is_empty() {
        return ok(format!("`{}` is empty.", rel_or_root(root, &dir)));
    }
    let mut text = format!("{}:\n{out}", rel_or_root(root, &dir));
    if truncated {
        text.push_str(&format!(
            "\n[listing stopped at {MAX_LIST_ENTRIES} entries — list a subdirectory to see more]\n"
        ));
    }
    ok(text)
}

/// Depth-first listing. Returns true when the entry cap cut it short.
fn walk_listing(
    root: &Path,
    dir: &Path,
    depth: u32,
    level: u32,
    out: &mut String,
    count: &mut usize,
) -> bool {
    if level >= depth {
        return false;
    }
    let mut entries: Vec<fs::DirEntry> = match fs::read_dir(dir) {
        Ok(rd) => rd.flatten().collect(),
        // An unreadable subdirectory shouldn't abort the whole listing.
        Err(_) => return false,
    };
    // Directories first, then files, each alphabetical — the order a person
    // would write the tree in, and stable across platforms (read_dir is not).
    entries.sort_by_key(|e| {
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        (!is_dir, e.file_name().to_string_lossy().to_lowercase())
    });

    let indent = "  ".repeat(level as usize);
    for entry in entries {
        if *count >= MAX_LIST_ENTRIES {
            return true;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            if SKIPPED_DIRS.contains(&name.as_str()) {
                out.push_str(&format!("{indent}{name}/  [skipped]\n"));
                *count += 1;
                continue;
            }
            out.push_str(&format!("{indent}{name}/\n"));
            *count += 1;
            // Don't descend through symlinked directories: they can point
            // outside the workspace, and a link loop would recurse forever.
            if !ft.is_symlink()
                && walk_listing(root, &entry.path(), depth, level + 1, out, count)
            {
                return true;
            }
        } else {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            out.push_str(&format!("{indent}{name}  ({})\n", human_size(size)));
            *count += 1;
        }
    }
    false
}

fn rel_or_root(root: &Path, p: &Path) -> String {
    let r = rel_display(root, p);
    if r.is_empty() {
        ".".to_string()
    } else {
        r
    }
}

fn human_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

pub fn dispatch_read_file(root: &Path, args: &Value) -> McpCallResult {
    let Some(rel) = args.get("path").and_then(|v| v.as_str()) else {
        return err("missing required `path` argument (string)");
    };
    let path = match resolve_read(root, rel) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    if path.is_dir() {
        return err(format!(
            "`{}` is a directory — use list_directory for it",
            display_rel(rel)
        ));
    }

    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) => return err(format!("couldn't read `{}`: {e}", display_rel(rel))),
    };
    let oversized = bytes.len() > MAX_READ_BYTES;
    let slice = if oversized {
        // Cut on a char boundary so from_utf8_lossy doesn't mangle the tail.
        let mut cut = MAX_READ_BYTES;
        while cut > 0 && (bytes[cut] & 0xC0) == 0x80 {
            cut -= 1;
        }
        &bytes[..cut]
    } else {
        &bytes[..]
    };
    if slice.contains(&0) {
        return err(format!(
            "`{}` looks like a binary file — this tool reads text only",
            display_rel(rel)
        ));
    }
    let text = String::from_utf8_lossy(slice);

    let start = super::lenient_i64(args, "start_line").unwrap_or(1).max(1) as usize;
    let max_lines = super::lenient_i64(args, "max_lines")
        .filter(|n| *n > 0)
        .map(|n| n as usize);

    let all: Vec<&str> = text.lines().collect();
    let total = all.len();
    if start > total && total > 0 {
        return err(format!(
            "`{}` has {total} lines; `start_line` {start} is past the end",
            display_rel(rel)
        ));
    }
    let end = match max_lines {
        Some(n) => (start - 1 + n).min(total),
        None => total,
    };

    let mut out = String::new();
    for (i, line) in all[start - 1..end].iter().enumerate() {
        out.push_str(&format!("{:>6}\t{line}\n", start + i));
    }
    if end < total {
        out.push_str(&format!(
            "\n[showing lines {start}-{end} of {total}. Call read_file again with start_line {} for more.]\n",
            end + 1
        ));
    } else if oversized {
        out.push_str(&format!(
            "\n[file is larger than {MAX_READ_BYTES} bytes and was truncated here.]\n"
        ));
    }
    ok(out)
}

pub fn dispatch_search_files(root: &Path, args: &Value) -> McpCallResult {
    let Some(pattern) = args.get("pattern").and_then(|v| v.as_str()) else {
        return err("missing required `pattern` argument (string)");
    };
    let case_sensitive = args
        .get("case_sensitive")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // `regex` has no backtracking, so a model-supplied pattern can't blow up
    // exponentially — but it *can* compile to a huge automaton, so bound the
    // program size rather than the runtime.
    let re = match regex::RegexBuilder::new(pattern)
        .case_insensitive(!case_sensitive)
        .size_limit(1 << 20)
        .build()
    {
        Ok(r) => r,
        Err(e) => return err(format!("invalid regular expression: {e}")),
    };

    let exts: Vec<String> = args
        .get("extensions")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim_start_matches('.').to_lowercase())
                .collect()
        })
        .unwrap_or_default();

    let rel = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
    let base = match resolve_read(root, rel) {
        Ok(p) => p,
        Err(e) => return err(e),
    };

    let mut matches = String::new();
    let mut match_count = 0usize;
    let mut files_read = 0usize;
    let mut hit_cap = false;

    let walker = walkdir::WalkDir::new(&base)
        .max_depth(MAX_DEPTH as usize)
        // Never follow links — the prefix check can't run per-entry here and
        // a loop would hang the walk.
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            !e.file_type().is_dir()
                || !SKIPPED_DIRS.contains(&e.file_name().to_string_lossy().as_ref())
        });

    for entry in walker.flatten() {
        if match_count >= MAX_SEARCH_MATCHES || files_read >= MAX_SEARCH_FILES {
            hit_cap = true;
            break;
        }
        // Skips symlinks as well as directories, and that is load-bearing:
        // with `follow_links(false)` walkdir reports a symlink's own type,
        // so `is_file()` is false for one. Without that, `fs::read` below
        // *would* follow a link out of the workspace — the walker refuses
        // to descend through symlinked directories, but it would happily
        // hand us a symlinked file. See the symlink test below.
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if !exts.is_empty() {
            let ok_ext = path
                .extension()
                .map(|e| exts.contains(&e.to_string_lossy().to_lowercase()))
                .unwrap_or(false);
            if !ok_ext {
                continue;
            }
        }
        let Ok(bytes) = fs::read(path) else { continue };
        files_read += 1;
        if bytes.len() > MAX_SEARCH_FILE_BYTES || bytes.contains(&0) {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&bytes) else {
            continue;
        };
        let shown = rel_display(root, path);
        for (i, line) in text.lines().enumerate() {
            if match_count >= MAX_SEARCH_MATCHES {
                hit_cap = true;
                break;
            }
            if re.is_match(line) {
                // Long minified lines would otherwise dominate the result.
                let trimmed = line.trim();
                let clipped: String = if trimmed.chars().count() > 200 {
                    trimmed.chars().take(200).collect::<String>() + "…"
                } else {
                    trimmed.to_string()
                };
                matches.push_str(&format!("{shown}:{}: {clipped}\n", i + 1));
                match_count += 1;
            }
        }
    }

    if match_count == 0 {
        return ok(format!("No matches for `{pattern}`."));
    }
    let mut text = format!("{match_count} match(es) for `{pattern}`:\n{matches}");
    if hit_cap {
        text.push_str("\n[stopped at the result cap — narrow the pattern or pass `path` to search a subdirectory]\n");
    }
    ok(text)
}

pub fn dispatch_write_file(root: &Path, args: &Value) -> McpCallResult {
    let Some(rel) = args.get("path").and_then(|v| v.as_str()) else {
        return err("missing required `path` argument (string)");
    };
    let Some(content) = args.get("content").and_then(|v| v.as_str()) else {
        return err("missing required `content` argument (string)");
    };
    if content.len() > MAX_WRITE_BYTES {
        return err(format!(
            "content is {} bytes; the limit is {MAX_WRITE_BYTES}",
            content.len()
        ));
    }
    let path = match resolve_write(root, rel) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    let existed = path.exists();
    if let Some(parent) = path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            return err(format!(
                "couldn't create the parent directory for `{}`: {e}",
                display_rel(rel)
            ));
        }
    }
    match fs::write(&path, content) {
        Ok(()) => ok(format!(
            "{} `{}` ({} bytes, {} lines).",
            if existed { "Overwrote" } else { "Created" },
            rel_display(root, &path),
            content.len(),
            content.lines().count()
        )),
        Err(e) => err(format!("couldn't write `{}`: {e}", display_rel(rel))),
    }
}

pub fn dispatch_edit_file(root: &Path, args: &Value) -> McpCallResult {
    let Some(rel) = args.get("path").and_then(|v| v.as_str()) else {
        return err("missing required `path` argument (string)");
    };
    let Some(old_text) = args.get("old_text").and_then(|v| v.as_str()) else {
        return err("missing required `old_text` argument (string)");
    };
    let Some(new_text) = args.get("new_text").and_then(|v| v.as_str()) else {
        return err("missing required `new_text` argument (string)");
    };
    if old_text.is_empty() {
        return err("`old_text` must not be empty — use write_file to create a file");
    }
    let replace_all = args
        .get("replace_all")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let path = match resolve_read(root, rel) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    let original = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => return err(format!("couldn't read `{}`: {e}", display_rel(rel))),
    };

    let hits = original.matches(old_text).count();
    if hits == 0 {
        return err(format!(
            "`old_text` does not appear in `{}`. Read the file and copy the \
             snippet exactly, including indentation.",
            display_rel(rel)
        ));
    }
    if hits > 1 && !replace_all {
        return err(format!(
            "`old_text` appears {hits} times in `{}`. Include more surrounding \
             context so it matches exactly once, or pass `replace_all: true`.",
            display_rel(rel)
        ));
    }

    let updated = if replace_all {
        original.replace(old_text, new_text)
    } else {
        original.replacen(old_text, new_text, 1)
    };
    if updated.len() > MAX_WRITE_BYTES {
        return err(format!(
            "the edited file would be {} bytes; the limit is {MAX_WRITE_BYTES}",
            updated.len()
        ));
    }
    match fs::write(&path, &updated) {
        Ok(()) => ok(format!(
            "Edited `{}` — replaced {hits} occurrence(s). File is now {} lines.",
            rel_display(root, &path),
            updated.lines().count()
        )),
        Err(e) => err(format!("couldn't write `{}`: {e}", display_rel(rel))),
    }
}

fn ok(text: impl Into<String>) -> McpCallResult {
    McpCallResult {
        content_text: text.into(),
        is_error: false,
        ..Default::default()
    }
}

fn err(msg: impl Into<String>) -> McpCallResult {
    McpCallResult {
        content_text: msg.into(),
        is_error: true,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A workspace with a couple of files. Returns the canonical root, which
    /// is what the real caller passes (`commands::pick_session_workspace`
    /// canonicalizes before storing).
    fn workspace() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonicalize root");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("README.md"), "# Title\nsecond line\n").unwrap();
        fs::write(
            root.join("src/main.rs"),
            "fn main() {\n    println!(\"hi\");\n}\n",
        )
        .unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), "module.exports={}\n").unwrap();
        (dir, root)
    }

    // ---- sandbox -------------------------------------------------------

    #[test]
    fn parent_traversal_is_refused() {
        let (_d, root) = workspace();
        for attempt in ["../secrets.txt", "src/../../outside", "a/b/../../../etc/passwd"] {
            let r = dispatch_read_file(&root, &json!({ "path": attempt }));
            assert!(r.is_error, "{attempt} should be refused");
            assert!(
                r.content_text.contains(".."),
                "{attempt} should say why: {}",
                r.content_text
            );
        }
    }

    #[test]
    fn absolute_paths_are_refused() {
        let (_d, root) = workspace();
        for attempt in ["/etc/passwd", "C:\\Windows\\win.ini"] {
            let r = dispatch_read_file(&root, &json!({ "path": attempt }));
            assert!(r.is_error, "{attempt} should be refused");
        }
    }

    #[test]
    fn writes_cannot_escape_the_root() {
        let (_d, root) = workspace();
        let r = dispatch_write_file(
            &root,
            &json!({ "path": "../escaped.txt", "content": "x" }),
        );
        assert!(r.is_error);
        assert!(
            !root.parent().unwrap().join("escaped.txt").exists(),
            "a file was created outside the workspace"
        );
    }

    /// The prefix check, not the `..` check, is what stops a link out of the
    /// tree — so exercise it directly. Unix-only: creating a symlink on
    /// Windows needs either developer mode or elevation.
    #[cfg(unix)]
    #[test]
    fn symlink_out_of_the_workspace_is_refused() {
        let (_d, root) = workspace();
        let outside = tempfile::TempDir::new().unwrap();
        fs::write(outside.path().join("secret.txt"), "classified\n").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("link")).unwrap();

        let r = dispatch_read_file(&root, &json!({ "path": "link/secret.txt" }));
        assert!(r.is_error, "symlink escape should be refused");
        assert!(!r.content_text.contains("classified"));

        // And the same link must not be a write path out either.
        let w = dispatch_write_file(
            &root,
            &json!({ "path": "link/planted.txt", "content": "x" }),
        );
        assert!(w.is_error, "write through an escaping symlink should be refused");
        assert!(!outside.path().join("planted.txt").exists());
    }

    /// `search_files` reads with `fs::read`, which follows symlinks — so the
    /// walker must never hand it one. Unix-only for the same reason as the
    /// test above: symlink creation on Windows needs elevation.
    #[cfg(unix)]
    #[test]
    fn search_does_not_read_through_a_symlinked_file() {
        let (_d, root) = workspace();
        let outside = tempfile::TempDir::new().unwrap();
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, "SUPERSECRETTOKEN
").unwrap();
        std::os::unix::fs::symlink(&secret, root.join("innocent.txt")).unwrap();

        let r = dispatch_search_files(&root, &json!({ "pattern": "SUPERSECRETTOKEN" }));
        assert!(!r.is_error, "{}", r.content_text);
        assert!(
            r.content_text.contains("No matches"),
            "search read through a symlink: {}",
            r.content_text
        );
    }

    // ---- reading -------------------------------------------------------

    #[test]
    fn read_file_numbers_lines() {
        let (_d, root) = workspace();
        let r = dispatch_read_file(&root, &json!({ "path": "README.md" }));
        assert!(!r.is_error, "{}", r.content_text);
        assert!(r.content_text.contains("     1\t# Title"));
        assert!(r.content_text.contains("     2\tsecond line"));
    }

    #[test]
    fn read_file_pages_with_start_and_max() {
        let (_d, root) = workspace();
        let r = dispatch_read_file(
            &root,
            &json!({ "path": "src/main.rs", "start_line": 2, "max_lines": 1 }),
        );
        assert!(!r.is_error, "{}", r.content_text);
        assert!(r.content_text.contains("     2\t    println!"));
        assert!(!r.content_text.contains("fn main"));
        assert!(r.content_text.contains("start_line 3"));
    }

    #[test]
    fn listing_skips_dependency_directories() {
        let (_d, root) = workspace();
        let r = dispatch_list_directory(&root, &json!({ "path": ".", "depth": 3 }));
        assert!(!r.is_error, "{}", r.content_text);
        assert!(r.content_text.contains("README.md"));
        assert!(r.content_text.contains("main.rs"));
        assert!(r.content_text.contains("node_modules/  [skipped]"));
        assert!(
            !r.content_text.contains("index.js"),
            "node_modules was descended into: {}",
            r.content_text
        );
    }

    #[test]
    fn search_finds_matches_with_line_numbers() {
        let (_d, root) = workspace();
        let r = dispatch_search_files(&root, &json!({ "pattern": "println" }));
        assert!(!r.is_error, "{}", r.content_text);
        assert!(r.content_text.contains("src/main.rs:2:"));
    }

    #[test]
    fn search_respects_the_extension_filter() {
        let (_d, root) = workspace();
        let r = dispatch_search_files(
            &root,
            &json!({ "pattern": "Title", "extensions": ["rs"] }),
        );
        assert!(!r.is_error);
        assert!(r.content_text.contains("No matches"));
    }

    #[test]
    fn search_rejects_a_bad_pattern_without_panicking() {
        let (_d, root) = workspace();
        let r = dispatch_search_files(&root, &json!({ "pattern": "(unclosed" }));
        assert!(r.is_error);
        assert!(r.content_text.contains("invalid regular expression"));
    }

    // ---- writing -------------------------------------------------------

    #[test]
    fn write_creates_missing_parents_inside_the_root() {
        let (_d, root) = workspace();
        let r = dispatch_write_file(
            &root,
            &json!({ "path": "a/b/c/new.txt", "content": "hello\n" }),
        );
        assert!(!r.is_error, "{}", r.content_text);
        assert_eq!(
            fs::read_to_string(root.join("a/b/c/new.txt")).unwrap(),
            "hello\n"
        );
        assert!(r.content_text.contains("Created"));
    }

    #[test]
    fn write_over_an_existing_file_says_so() {
        let (_d, root) = workspace();
        let r = dispatch_write_file(&root, &json!({ "path": "README.md", "content": "new\n" }));
        assert!(!r.is_error, "{}", r.content_text);
        assert!(r.content_text.contains("Overwrote"));
        assert_eq!(fs::read_to_string(root.join("README.md")).unwrap(), "new\n");
    }

    #[test]
    fn write_refuses_to_target_a_directory() {
        let (_d, root) = workspace();
        let r = dispatch_write_file(&root, &json!({ "path": "src", "content": "x" }));
        assert!(r.is_error);
        assert!(r.content_text.contains("directory"));
    }

    #[test]
    fn edit_replaces_a_unique_snippet() {
        let (_d, root) = workspace();
        let r = dispatch_edit_file(
            &root,
            &json!({ "path": "src/main.rs", "old_text": "\"hi\"", "new_text": "\"bye\"" }),
        );
        assert!(!r.is_error, "{}", r.content_text);
        assert!(fs::read_to_string(root.join("src/main.rs"))
            .unwrap()
            .contains("\"bye\""));
    }

    #[test]
    fn ambiguous_edit_is_refused_rather_than_guessed() {
        let (_d, root) = workspace();
        fs::write(root.join("dup.txt"), "x\nx\n").unwrap();
        let r = dispatch_edit_file(
            &root,
            &json!({ "path": "dup.txt", "old_text": "x", "new_text": "y" }),
        );
        assert!(r.is_error);
        assert!(r.content_text.contains("appears 2 times"));
        // Nothing was written.
        assert_eq!(fs::read_to_string(root.join("dup.txt")).unwrap(), "x\nx\n");

        let all = dispatch_edit_file(
            &root,
            &json!({ "path": "dup.txt", "old_text": "x", "new_text": "y", "replace_all": true }),
        );
        assert!(!all.is_error, "{}", all.content_text);
        assert_eq!(fs::read_to_string(root.join("dup.txt")).unwrap(), "y\ny\n");
    }

    #[test]
    fn edit_with_no_match_reports_it() {
        let (_d, root) = workspace();
        let r = dispatch_edit_file(
            &root,
            &json!({ "path": "README.md", "old_text": "nowhere", "new_text": "x" }),
        );
        assert!(r.is_error);
        assert!(r.content_text.contains("does not appear"));
    }

    // ---- approval policy -----------------------------------------------

    #[test]
    fn only_mutating_tools_require_approval() {
        assert!(requires_approval(WRITE_FILE));
        assert!(requires_approval(EDIT_FILE));
        assert!(!requires_approval(READ_FILE));
        assert!(!requires_approval(LIST_DIRECTORY));
        assert!(!requires_approval(SEARCH_FILES));
    }
}
