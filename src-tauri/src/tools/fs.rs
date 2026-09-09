//! Workspace filesystem tools — the model's read/write access to one
//! directory the user picked for the current chat.
//!
//! Unlike every other built-in, these are *not* pure functions of their
//! arguments: each one is resolved against the chat's workspace root
//! (`sessions.workspace_root`), which is why [`super::builtin::Dispatch`]
//! carries a `Workspace` variant. No root on the session means the tools
//! are never even offered to the model.
//!
//! Eight tools, in two groups. `list_directory`, `find_files`, `read_file`
//! and `search_files` only look; `write_file`, `edit_file`, `move_file` and
//! `delete_file` change the user's files and go through the per-call
//! approval prompt ([`requires_approval`]). There is deliberately no shell
//! and no recursive delete: every approved call touches one file, or one
//! empty directory, so the blast radius of a mistaken "Allow" is bounded.
//!
//! ## The sandbox
//!
//! Everything funnels through [`resolve_read`] / [`resolve_target`], which
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
//! The root handed to every dispatcher is canonical — `commands::chat_stream`
//! canonicalizes the stored path each turn — so the prefix comparison is
//! canonical-vs-canonical on both sides. On Windows that means both carry
//! the `\\?\` verbatim prefix and `starts_with` compares whole components
//! rather than raw strings. That prefix is an implementation detail of the
//! check, though, not something a person should read: [`display_path`]
//! strips it for anything shown to the user or the model.

use std::fs;
use std::io::Read as _;
use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

use crate::mcp::McpCallResult;

pub const LIST_DIRECTORY: &str = "list_directory";
pub const FIND_FILES: &str = "find_files";
pub const READ_FILE: &str = "read_file";
pub const SEARCH_FILES: &str = "search_files";
pub const WRITE_FILE: &str = "write_file";
pub const EDIT_FILE: &str = "edit_file";
pub const MOVE_FILE: &str = "move_file";
pub const DELETE_FILE: &str = "delete_file";

/// Single settings toggle for the whole group. The eight tools are one
/// capability from the user's point of view ("let the model work in a
/// folder"), and splitting them into eight switches would let someone
/// enable `write_file` while disabling `read_file` — a combination with
/// no sensible use.
///
/// Singular `_tool_enabled` despite covering eight tools: that suffix is how
/// `tests/settingsAllowlist.test.ts` recognises a key as registry-owned
/// rather than one needing a hand-written `WRITABLE_SETTING_KEYS` entry.
pub const SETTING_KEY: &str = "workspace_tool_enabled";

/// Tools that mutate the workspace. These are the ones
/// [`crate::mcp::needs_approval`] parks on the consent prompt: reads are
/// bounded by the sandbox and can only surface what is already inside a
/// directory the user deliberately picked, but a write, move or delete
/// changes their files, so it gets an explicit yes with the path and
/// payload on screen.
pub fn requires_approval(name: &str) -> bool {
    matches!(name, WRITE_FILE | EDIT_FILE | MOVE_FILE | DELETE_FILE)
}

/// Largest file `read_file` will open at all. Anything bigger is almost
/// certainly a log, a fixture or a bundle, and `search_files` is the right
/// tool for those; refusing up front also means the whole file can be held
/// in memory for line-based paging without a second thought.
const MAX_READ_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// Budget for one `read_file` response. Kept under the per-result cap the
/// provider loop applies to every tool result, so the paging trailer this
/// tool writes — which names the exact `start_line` to continue from — is
/// what the model sees, rather than the generic "result truncated" note
/// that would replace it if the response were allowed to run past the cap.
const MAX_READ_OUTPUT_BYTES: usize = crate::providers::MAX_TOOL_RESULT_BYTES - 4 * 1024;
/// Longest single line echoed back before it is clipped. Minified bundles
/// and data files have lines far longer than any model needs to see.
const MAX_LINE_CHARS: usize = 2_000;
/// Ceiling on a single `write_file` payload. A model emitting more than a
/// megabyte into one file is malfunctioning, not authoring.
const MAX_WRITE_BYTES: usize = 1024 * 1024;
const MAX_LIST_ENTRIES: usize = 500;
const MAX_FIND_RESULTS: usize = 200;
/// Directory entries `find_files` will look at before giving up. Bounds
/// the wall-clock on a huge tree so the call answers with a hint instead
/// of tripping the 20 s built-in timeout.
const MAX_FIND_VISITED: usize = 50_000;
const MAX_SEARCH_MATCHES: usize = 100;
/// Files opened during one `search_files` call. Bounds the wall-clock so a
/// search can't eat the 20 s built-in timeout on a large tree.
const MAX_SEARCH_FILES: usize = 2_000;
const MAX_DEPTH: u32 = 8;
/// Largest file `search_files` will open. Checked against the directory
/// entry's size *before* the file is read, so a multi-gigabyte log in the
/// tree costs a stat, not an allocation.
const MAX_SEARCH_FILE_BYTES: u64 = 512 * 1024;
/// How much of an existing file `write_file` samples to learn its line
/// endings before overwriting it.
const LINE_ENDING_SNIFF_BYTES: u64 = 64 * 1024;

/// Project instructions file, read from the workspace root on every turn
/// and appended to the system prompt — the same idea as a `CLAUDE.md` or
/// `AGENTS.md`: the project's own notes on how to work in the tree.
pub const INSTRUCTIONS_FILE: &str = "LOACHFILE.md";
/// How much of `LOACHFILE.md` reaches the prompt. The same cap as a tool
/// result: past this the file is a document rather than instructions, and
/// local models follow short instruction files far better anyway.
const MAX_INSTRUCTIONS_BYTES: usize = crate::providers::MAX_TOOL_RESULT_BYTES;

/// Directories skipped when *walking* (`list_directory`, `find_files`,
/// `search_files`). Naming one explicitly still works — the user may well
/// want `read_file(".git/config")` or `search_files` inside `target/` —
/// this only stops a walk from drowning in dependency and build output.
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

/// Resolve a path that may not exist yet — the target of a write, or the
/// destination of a move.
///
/// The target itself can't be canonicalized (it may not be there), so we
/// canonicalize the deepest ancestor that *does* exist, prefix-check that,
/// and re-append the remaining components. Those components came out of
/// [`vet_relative`], so every one is `Normal` — no `..`, no root — and
/// appending them to an in-root canonical base therefore cannot leave the
/// root.
fn resolve_target(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let vetted = vet_relative(rel)?;
    if vetted.as_os_str().is_empty() {
        return Err(
            "the path must name something inside the workspace, not the workspace root itself"
                .into(),
        );
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

    // `base` is canonical and inside the root; anything left over is a
    // plain name that doesn't exist yet. If everything existed, `base` is
    // the canonical target itself — a link inside the root that points
    // inside the root resolves to its real file, which is still the user's
    // directory and still theirs to change.
    let mut target = base;
    for part in &remaining {
        target.push(part);
    }
    Ok(target)
}

/// Resolve a file to create or overwrite.
fn resolve_write(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let target = resolve_target(root, rel)?;
    if target.is_dir() {
        return Err(format!(
            "`{}` is a directory, not a file",
            display_rel(rel)
        ));
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

/// An absolute path as a person should read it. On Windows `canonicalize`
/// yields the verbatim form (`\\?\C:\Users\…`); that prefix is right for
/// the sandbox's component comparison but wrong for a tooltip or a system
/// prompt, where it just looks broken. `dunce` strips it only when the
/// result is guaranteed to mean the same path — a verbatim UNC share
/// (`\\?\UNC\server\…`) or an over-long path stays as it is — and other
/// platforms pass through unchanged.
pub fn display_path(p: &Path) -> String {
    dunce::simplified(p).to_string_lossy().into_owned()
}

// ---------------------------------------------------------------------------
// Line endings
// ---------------------------------------------------------------------------

/// The line ending a file uses, judged by its first line break. Files with
/// no line break at all count as LF.
fn line_ending_of(text: &str) -> &'static str {
    match text.find('\n') {
        Some(i) if text.as_bytes()[..i].ends_with(b"\r") => "\r\n",
        _ => "\n",
    }
}

/// Bring `content` — which models almost always emit with bare `\n` — into
/// line with a CRLF file, so an overwrite on Windows doesn't flip a whole
/// file to LF. Content that already carries `\r\n` is left alone.
fn match_line_endings(existing_ending: &str, content: &str) -> String {
    if existing_ending == "\r\n" && !content.contains("\r\n") {
        content.replace('\n', "\r\n")
    } else {
        content.to_string()
    }
}

/// Line ending of the file at `path`, from its first 64 KiB. Anything that
/// can't be read counts as LF; the write that follows will report the real
/// error.
fn sniff_line_ending(path: &Path) -> &'static str {
    let mut head = Vec::new();
    let read = fs::File::open(path)
        .and_then(|f| f.take(LINE_ENDING_SNIFF_BYTES).read_to_end(&mut head));
    if read.is_err() {
        return "\n";
    }
    line_ending_of(&String::from_utf8_lossy(&head))
}

// ---------------------------------------------------------------------------
// Project instructions
// ---------------------------------------------------------------------------

/// The workspace's `LOACHFILE.md`, ready for the system prompt, or `None`
/// when there isn't one worth sending.
///
/// Resolved through the same sandbox as every tool path, so a
/// `LOACHFILE.md` that is a symlink out of the tree is refused rather than
/// followed. Anything else that can't be used — a directory by that name, a
/// binary, a blank file, an I/O error — also counts as absent: the file is
/// a courtesy to the model, not something a turn should fail on.
///
/// Reads at most the cap plus one byte, so a runaway file costs one bounded
/// read; what survives is clipped to [`MAX_INSTRUCTIONS_BYTES`] with a note
/// that says so and names the real size.
pub fn read_workspace_instructions(root: &Path) -> Option<String> {
    let path = resolve_read(root, INSTRUCTIONS_FILE).ok()?;
    if !path.is_file() {
        return None;
    }
    let file = fs::File::open(&path).ok()?;
    let total = file.metadata().ok()?.len();
    let mut bytes = Vec::new();
    file.take(MAX_INSTRUCTIONS_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.contains(&0) {
        return None;
    }
    if bytes.len() <= MAX_INSTRUCTIONS_BYTES {
        let text = String::from_utf8_lossy(&bytes);
        let trimmed = text.trim();
        return (!trimmed.is_empty()).then(|| trimmed.to_string());
    }
    bytes.truncate(MAX_INSTRUCTIONS_BYTES);
    // A multi-byte character split by the cut comes out of the lossy decode
    // as a trailing U+FFFD; drop it rather than send the model garbage.
    let text = String::from_utf8_lossy(&bytes);
    let body = text.trim_end_matches('\u{FFFD}').trim();
    Some(format!(
        "{body}\n\n[{INSTRUCTIONS_FILE} truncated by Loach at {}; the file is {}. \
         Keep project instructions short.]",
        human_size(MAX_INSTRUCTIONS_BYTES as u64),
        human_size(total)
    ))
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

pub fn list_directory_description() -> &'static str {
    "List files and subdirectories inside the chat's workspace directory. \
     Paths are relative to the workspace root; use `.` for the root itself. \
     Start here to find out what the project contains before reading files. \
     Dependency and build directories (node_modules, target, dist, .git, …) \
     are skipped. To locate a file by name in a large tree, use `find_files` \
     instead of listing level by level."
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

pub fn find_files_description() -> &'static str {
    "Find files and directories by name inside the chat's workspace \
     directory, using a glob pattern. A pattern without a slash matches \
     names anywhere in the tree: `*.rs` finds every Rust file, `*config*` \
     anything with `config` in its name. A pattern with a slash matches the \
     path relative to the workspace root, e.g. `src/**/*.test.ts`. Matching \
     ignores case. Use this when you know (part of) a file's name; use \
     `search_files` when you know what it contains. Dependency and build \
     directories are skipped."
}

pub fn find_files_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string",
                "description": "Glob pattern: `*` matches within a name, `**` matches across directories, `?` one character, `[abc]` a set."
            },
            "path": {
                "type": "string",
                "description": "Subdirectory to search, relative to the workspace root. Defaults to the whole workspace."
            }
        },
        "required": ["pattern"],
        "additionalProperties": false
    })
}

pub fn read_file_description() -> &'static str {
    "Read a text file from the chat's workspace directory. Returns the \
     contents with 1-based line numbers prefixed, so you can refer to and \
     edit exact lines afterwards. The path is relative to the workspace \
     root. Long files come back one page at a time, ending with the \
     `start_line` to continue from; pass `start_line` / `max_lines` to read \
     a specific region."
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
                "description": "How many lines to return. Default: as many as fit in one response."
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
     build directories are skipped unless named in `path`, and binary files \
     are ignored."
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
     directory. Read the file first so `old_text` matches exactly, including \
     indentation; line endings are handled for you. `old_text` must occur \
     exactly once unless `replace_all` is true — an ambiguous edit is refused \
     rather than guessed at. The user is asked to approve every edit before \
     it happens."
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

pub fn move_file_description() -> &'static str {
    "Move or rename a file or directory inside the chat's workspace \
     directory. Both paths are relative to the workspace root; missing \
     parent directories of `to` are created, and an existing `to` is never \
     overwritten. The user is asked to approve every move before it happens."
}

pub fn move_file_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "from": {
                "type": "string",
                "description": "Existing file or directory, relative to the workspace root."
            },
            "to": {
                "type": "string",
                "description": "New path, relative to the workspace root. Must not already exist."
            }
        },
        "required": ["from", "to"],
        "additionalProperties": false
    })
}

pub fn delete_file_description() -> &'static str {
    "Delete one file, or one empty directory, inside the chat's workspace \
     directory. Non-empty directories are refused — delete their contents \
     first — so each approved call removes exactly one thing. The user is \
     asked to approve every deletion before it happens."
}

pub fn delete_file_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "File or empty directory to delete, relative to the workspace root."
            }
        },
        "required": ["path"],
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
            "\n[listing stopped at {MAX_LIST_ENTRIES} entries — list a subdirectory, or use find_files to locate a file by name]\n"
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

/// Whether a walk should descend into `entry`. The root of the walk is
/// always allowed through — the model named it on purpose, even if it is
/// `target/` — below that, the usual dependency/build directories are cut.
fn walk_allows(entry: &walkdir::DirEntry) -> bool {
    entry.depth() == 0
        || !entry.file_type().is_dir()
        || !SKIPPED_DIRS.contains(&entry.file_name().to_string_lossy().as_ref())
}

pub fn dispatch_find_files(root: &Path, args: &Value) -> McpCallResult {
    let Some(pattern) = args.get("pattern").and_then(|v| v.as_str()) else {
        return err("missing required `pattern` argument (string)");
    };
    let pattern = pattern.trim().replace('\\', "/");
    if pattern.is_empty() {
        return err("`pattern` must not be empty");
    }
    let glob = match glob::Pattern::new(&pattern) {
        Ok(g) => g,
        Err(e) => return err(format!("invalid glob pattern: {e}")),
    };
    // A bare name pattern (`*.rs`) is matched against each entry's own
    // name, so it finds files at any depth; a pattern with a `/` is matched
    // against the path relative to the search root, where `*` stops at a
    // separator and `**` is the way across directories.
    let name_only = !pattern.contains('/');
    let opts = glob::MatchOptions {
        case_sensitive: false,
        require_literal_separator: !name_only,
        require_literal_leading_dot: false,
    };

    let rel = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
    let base = match resolve_read(root, rel) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    if !base.is_dir() {
        return err(format!("`{}` is not a directory", display_rel(rel)));
    }

    let mut found: Vec<String> = Vec::new();
    let mut visited = 0usize;
    let mut hit_cap = false;
    let walker = walkdir::WalkDir::new(&base)
        .max_depth(MAX_DEPTH as usize)
        .follow_links(false)
        .into_iter()
        .filter_entry(walk_allows);
    for entry in walker.flatten() {
        if entry.depth() == 0 {
            continue;
        }
        visited += 1;
        if visited > MAX_FIND_VISITED || found.len() >= MAX_FIND_RESULTS {
            hit_cap = true;
            break;
        }
        let candidate = if name_only {
            entry.file_name().to_string_lossy().into_owned()
        } else {
            rel_display(&base, entry.path())
        };
        if glob.matches_with(&candidate, opts) {
            let mut shown = rel_display(root, entry.path());
            if entry.file_type().is_dir() {
                shown.push('/');
            }
            found.push(shown);
        }
    }

    if found.is_empty() {
        return ok(format!("No files match `{pattern}`."));
    }
    found.sort();
    let mut text = format!("{} match(es) for `{pattern}`:\n", found.len());
    for f in &found {
        text.push_str(f);
        text.push('\n');
    }
    if hit_cap {
        text.push_str(
            "\n[stopped at the result cap — narrow the pattern or pass `path` to search a subdirectory]\n",
        );
    }
    ok(text)
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

    // Size first, so a huge file is refused with a stat rather than after
    // being pulled into memory.
    let len = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if len > MAX_READ_FILE_BYTES {
        return err(format!(
            "`{}` is {}; read_file handles files up to {}. Use search_files to \
             find the lines you need.",
            display_rel(rel),
            human_size(len),
            human_size(MAX_READ_FILE_BYTES)
        ));
    }
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) => return err(format!("couldn't read `{}`: {e}", display_rel(rel))),
    };
    if bytes.contains(&0) {
        return err(format!(
            "`{}` looks like a binary file — this tool reads text only",
            display_rel(rel)
        ));
    }
    let text = String::from_utf8_lossy(&bytes);

    let start = super::lenient_i64(args, "start_line").unwrap_or(1).max(1) as usize;
    let max_lines = super::lenient_i64(args, "max_lines")
        .filter(|n| *n > 0)
        .map(|n| n as usize);

    let all: Vec<&str> = text.lines().collect();
    let total = all.len();
    if total == 0 {
        // Say so explicitly: an empty result reads like a failed call.
        return ok(format!("`{}` is empty (0 bytes).", display_rel(rel)));
    }
    if start > total {
        return err(format!(
            "`{}` has {total} lines; `start_line` {start} is past the end",
            display_rel(rel)
        ));
    }
    let want_end = match max_lines {
        Some(n) => (start - 1 + n).min(total),
        None => total,
    };

    // Emit whole lines until the response budget is spent. The first line
    // always goes out, however long, so a request can't stall on it.
    let mut out = String::new();
    let mut end = start - 1;
    for (i, line) in all[start - 1..want_end].iter().enumerate() {
        let row = format!("{:>6}\t{}\n", start + i, clip_line(line));
        if !out.is_empty() && out.len() + row.len() > MAX_READ_OUTPUT_BYTES {
            break;
        }
        out.push_str(&row);
        end = start + i;
    }
    if end < total {
        out.push_str(&format!(
            "\n[showing lines {start}-{end} of {total}. Call read_file again with start_line {} for more.]\n",
            end + 1
        ));
    }
    ok(out)
}

/// Clip one very long line so a minified bundle can't fill the whole
/// response with a single row.
fn clip_line(line: &str) -> std::borrow::Cow<'_, str> {
    if line.chars().count() <= MAX_LINE_CHARS {
        return std::borrow::Cow::Borrowed(line);
    }
    let head: String = line.chars().take(MAX_LINE_CHARS).collect();
    std::borrow::Cow::Owned(format!("{head}… [line truncated at {MAX_LINE_CHARS} characters]"))
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
    let mut hit_match_cap = false;
    let mut hit_file_cap = false;

    let walker = walkdir::WalkDir::new(&base)
        .max_depth(MAX_DEPTH as usize)
        // Never follow links — the prefix check can't run per-entry here and
        // a loop would hang the walk.
        .follow_links(false)
        .into_iter()
        .filter_entry(walk_allows);

    for entry in walker.flatten() {
        if match_count >= MAX_SEARCH_MATCHES {
            hit_match_cap = true;
            break;
        }
        if files_read >= MAX_SEARCH_FILES {
            hit_file_cap = true;
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
        // Stat before read: a huge file must cost nothing more than a
        // directory entry.
        let size = entry.metadata().map(|m| m.len()).unwrap_or(u64::MAX);
        if size > MAX_SEARCH_FILE_BYTES {
            continue;
        }
        let Ok(bytes) = fs::read(path) else { continue };
        files_read += 1;
        if bytes.contains(&0) {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&bytes) else {
            continue;
        };
        let shown = rel_display(root, path);
        for (i, line) in text.lines().enumerate() {
            if match_count >= MAX_SEARCH_MATCHES {
                hit_match_cap = true;
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
        if hit_file_cap {
            return ok(format!(
                "No matches for `{pattern}` in the first {MAX_SEARCH_FILES} files. \
                 Pass `path` or `extensions` to narrow the search."
            ));
        }
        return ok(format!("No matches for `{pattern}`."));
    }
    let mut text = format!("{match_count} match(es) for `{pattern}`:\n{matches}");
    if hit_match_cap {
        text.push_str("\n[stopped at the result cap — narrow the pattern or pass `path` to search a subdirectory]\n");
    } else if hit_file_cap {
        text.push_str(&format!(
            "\n[stopped after {MAX_SEARCH_FILES} files — pass `path` or `extensions` to narrow the search]\n"
        ));
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
    // Keep an existing file's line endings: a model rewriting a CRLF file
    // with bare `\n` would otherwise flip every line and drown the real
    // change in the diff.
    let content = if existed {
        match_line_endings(sniff_line_ending(&path), content)
    } else {
        content.to_string()
    };
    if let Some(parent) = path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            return err(format!(
                "couldn't create the parent directory for `{}`: {e}",
                display_rel(rel)
            ));
        }
    }
    match fs::write(&path, &content) {
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
    if path.is_dir() {
        return err(format!("`{}` is a directory, not a file", display_rel(rel)));
    }
    let original = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => return err(format!("couldn't read `{}`: {e}", display_rel(rel))),
    };

    // Match on `\n` regardless of what the file uses. `read_file` shows the
    // model lines without their `\r`, so a multi-line `old_text` copied
    // from it can never match a CRLF file byte for byte; normalise both
    // sides, edit, then restore the file's own ending. A CRLF file with a
    // few stray bare `\n` lines comes out uniformly CRLF — the one case
    // where this touches lines the model didn't.
    let crlf = line_ending_of(&original) == "\r\n";
    let haystack = if crlf {
        original.replace("\r\n", "\n")
    } else {
        original
    };
    let old_n = old_text.replace("\r\n", "\n");
    let new_n = new_text.replace("\r\n", "\n");

    let hits = haystack.matches(old_n.as_str()).count();
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
        haystack.replace(old_n.as_str(), &new_n)
    } else {
        haystack.replacen(old_n.as_str(), &new_n, 1)
    };
    let updated = if crlf {
        updated.replace('\n', "\r\n")
    } else {
        updated
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

pub fn dispatch_move_file(root: &Path, args: &Value) -> McpCallResult {
    let Some(from) = args.get("from").and_then(|v| v.as_str()) else {
        return err("missing required `from` argument (string)");
    };
    let Some(to) = args.get("to").and_then(|v| v.as_str()) else {
        return err("missing required `to` argument (string)");
    };
    let src = match resolve_read(root, from) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    if src == root {
        return err("the workspace root itself can't be moved");
    }
    let dst = match resolve_target(root, to) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    if dst.exists() {
        return err(format!(
            "`{}` already exists — move_file never overwrites. Delete it first \
             or pick another name.",
            display_rel(to)
        ));
    }
    if src.is_dir() && dst.starts_with(&src) {
        return err(format!(
            "can't move `{}` inside itself",
            display_rel(from)
        ));
    }
    if let Some(parent) = dst.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            return err(format!(
                "couldn't create the parent directory for `{}`: {e}",
                display_rel(to)
            ));
        }
    }
    match fs::rename(&src, &dst) {
        Ok(()) => ok(format!(
            "Moved `{}` to `{}`.",
            rel_display(root, &src),
            rel_display(root, &dst)
        )),
        Err(e) => err(format!(
            "couldn't move `{}` to `{}`: {e}",
            display_rel(from),
            display_rel(to)
        )),
    }
}

pub fn dispatch_delete_file(root: &Path, args: &Value) -> McpCallResult {
    let Some(rel) = args.get("path").and_then(|v| v.as_str()) else {
        return err("missing required `path` argument (string)");
    };
    let target = match resolve_read(root, rel) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    if target == root {
        return err("the workspace root itself can't be deleted");
    }
    let meta = match fs::metadata(&target) {
        Ok(m) => m,
        Err(e) => return err(format!("`{}` is not readable: {e}", display_rel(rel))),
    };
    let shown = rel_display(root, &target);
    if meta.is_dir() {
        let non_empty = fs::read_dir(&target)
            .map(|mut rd| rd.next().is_some())
            .unwrap_or(true);
        if non_empty {
            return err(format!(
                "`{shown}/` is not empty. delete_file removes one file or one \
                 empty directory per call — delete its contents first."
            ));
        }
        return match fs::remove_dir(&target) {
            Ok(()) => ok(format!("Deleted directory `{shown}/`.")),
            Err(e) => err(format!("couldn't delete `{shown}/`: {e}")),
        };
    }
    match fs::remove_file(&target) {
        Ok(()) => ok(format!("Deleted `{shown}` ({}).", human_size(meta.len()))),
        Err(e) => err(format!("couldn't delete `{shown}`: {e}")),
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
    /// is what the real caller passes (`commands::chat_stream` canonicalizes
    /// the stored path every turn).
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

    #[test]
    fn moves_and_deletes_cannot_escape_the_root() {
        let (_d, root) = workspace();
        let m = dispatch_move_file(
            &root,
            &json!({ "from": "README.md", "to": "../escaped.md" }),
        );
        assert!(m.is_error, "{}", m.content_text);
        assert!(root.join("README.md").exists(), "the file was moved out");

        let d = dispatch_delete_file(&root, &json!({ "path": "../something" }));
        assert!(d.is_error);
        for attempt in [".", ""] {
            let d = dispatch_delete_file(&root, &json!({ "path": attempt }));
            assert!(d.is_error, "deleting the root via `{attempt}` should be refused");
            assert!(root.exists());
        }
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

        // Nor a delete or move target.
        let d = dispatch_delete_file(&root, &json!({ "path": "link/secret.txt" }));
        assert!(d.is_error);
        assert!(outside.path().join("secret.txt").exists());
        let m = dispatch_move_file(
            &root,
            &json!({ "from": "README.md", "to": "link/moved.md" }),
        );
        assert!(m.is_error);
        assert!(root.join("README.md").exists());
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
        fs::write(&secret, "SUPERSECRETTOKEN\n").unwrap();
        std::os::unix::fs::symlink(&secret, root.join("innocent.txt")).unwrap();

        let r = dispatch_search_files(&root, &json!({ "pattern": "SUPERSECRETTOKEN" }));
        assert!(!r.is_error, "{}", r.content_text);
        assert!(
            r.content_text.contains("No matches"),
            "search read through a symlink: {}",
            r.content_text
        );
    }

    #[cfg(windows)]
    #[test]
    fn display_path_drops_the_verbatim_prefix() {
        assert_eq!(
            display_path(Path::new(r"\\?\C:\Users\me\code")),
            r"C:\Users\me\code"
        );
        // And the real thing: a canonical temp dir reads like a normal path.
        let (_d, root) = workspace();
        assert!(!display_path(&root).starts_with(r"\\?\"));
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

    /// An empty file used to come back as an empty string, and with a
    /// `start_line` past 1 it hit an inverted slice range and panicked.
    #[test]
    fn read_file_handles_an_empty_file() {
        let (_d, root) = workspace();
        fs::write(root.join("empty.txt"), "").unwrap();
        let r = dispatch_read_file(&root, &json!({ "path": "empty.txt" }));
        assert!(!r.is_error, "{}", r.content_text);
        assert!(r.content_text.contains("is empty"), "{}", r.content_text);

        let r2 = dispatch_read_file(&root, &json!({ "path": "empty.txt", "start_line": 5 }));
        assert!(!r2.is_error, "{}", r2.content_text);
        assert!(r2.content_text.contains("is empty"));

        let past = dispatch_read_file(&root, &json!({ "path": "README.md", "start_line": 9 }));
        assert!(past.is_error);
        assert!(past.content_text.contains("past the end"));
    }

    /// A big file is paged by the tool's own budget — with the trailer that
    /// names the next `start_line` — rather than clipped by the provider's
    /// generic cap, which would swallow that hint.
    #[test]
    fn read_file_pages_a_long_file_within_the_result_cap() {
        let (_d, root) = workspace();
        let body: String = (1..=4000)
            .map(|i| format!("line number {i} with a little padding text\n"))
            .collect();
        fs::write(root.join("big.txt"), &body).unwrap();

        let r = dispatch_read_file(&root, &json!({ "path": "big.txt" }));
        assert!(!r.is_error, "{}", r.content_text);
        assert!(
            r.content_text.len() <= crate::providers::MAX_TOOL_RESULT_BYTES,
            "response ({} bytes) would be clipped by the provider cap",
            r.content_text.len()
        );
        assert!(r.content_text.contains("showing lines 1-"));
        assert!(r.content_text.contains("Call read_file again with start_line"));

        // Paging from the far end reaches the last line.
        let tail = dispatch_read_file(&root, &json!({ "path": "big.txt", "start_line": 3990 }));
        assert!(tail.content_text.contains("  4000\tline number 4000"));
        assert!(!tail.content_text.contains("Call read_file again"));
    }

    #[test]
    fn read_file_clips_a_very_long_line() {
        let (_d, root) = workspace();
        let long = "x".repeat(MAX_LINE_CHARS + 500);
        fs::write(root.join("min.js"), format!("short\n{long}\nafter\n")).unwrap();
        let r = dispatch_read_file(&root, &json!({ "path": "min.js" }));
        assert!(!r.is_error, "{}", r.content_text);
        assert!(r.content_text.contains("line truncated"));
        assert!(r.content_text.contains("     3\tafter"), "later lines still shown");
    }

    #[test]
    fn read_file_refuses_a_huge_file_without_reading_it() {
        let (_d, root) = workspace();
        // Sparse: costs no disk, but reads as MAX + 1 bytes.
        let f = fs::File::create(root.join("huge.log")).unwrap();
        f.set_len(MAX_READ_FILE_BYTES + 1).unwrap();
        let r = dispatch_read_file(&root, &json!({ "path": "huge.log" }));
        assert!(r.is_error);
        assert!(r.content_text.contains("search_files"), "{}", r.content_text);
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
    fn find_files_matches_names_anywhere_and_paths_when_slashed() {
        let (_d, root) = workspace();
        fs::create_dir_all(root.join("src/util")).unwrap();
        fs::write(root.join("src/util/Helpers.RS"), "").unwrap();

        // Name-only pattern: any depth, case-insensitive.
        let r = dispatch_find_files(&root, &json!({ "pattern": "*.rs" }));
        assert!(!r.is_error, "{}", r.content_text);
        assert!(r.content_text.contains("src/main.rs"));
        assert!(r.content_text.contains("src/util/Helpers.RS"));
        assert!(!r.content_text.contains("README"));

        // Slashed pattern: `*` stops at separators, `**` crosses them.
        let top = dispatch_find_files(&root, &json!({ "pattern": "src/*.rs" }));
        assert!(top.content_text.contains("src/main.rs"));
        assert!(!top.content_text.contains("Helpers"), "{}", top.content_text);
        let deep = dispatch_find_files(&root, &json!({ "pattern": "src/**/*.rs" }));
        assert!(deep.content_text.contains("Helpers"), "{}", deep.content_text);

        // Directories are found too, marked with a trailing slash.
        let dirs = dispatch_find_files(&root, &json!({ "pattern": "util" }));
        assert!(dirs.content_text.contains("src/util/"), "{}", dirs.content_text);

        // Skipped directories stay skipped; nothing matching is an answer,
        // not an error; a bad pattern is an error.
        let js = dispatch_find_files(&root, &json!({ "pattern": "*.js" }));
        assert!(js.content_text.contains("No files match"));
        let bad = dispatch_find_files(&root, &json!({ "pattern": "[unclosed" }));
        assert!(bad.is_error);
        assert!(bad.content_text.contains("invalid glob"));
    }

    #[test]
    fn find_files_scoped_to_a_subdirectory() {
        let (_d, root) = workspace();
        let r = dispatch_find_files(&root, &json!({ "pattern": "*.md", "path": "src" }));
        assert!(r.content_text.contains("No files match"), "{}", r.content_text);
        let r = dispatch_find_files(&root, &json!({ "pattern": "*.rs", "path": "src" }));
        assert!(r.content_text.contains("src/main.rs"));
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

    /// Naming a skipped directory as `path` is an explicit request: the
    /// walk must not filter its own root away and answer "No matches".
    #[test]
    fn search_and_find_work_inside_an_explicitly_named_skipped_dir() {
        let (_d, root) = workspace();
        let r = dispatch_search_files(
            &root,
            &json!({ "pattern": "exports", "path": "node_modules" }),
        );
        assert!(!r.is_error, "{}", r.content_text);
        assert!(
            r.content_text.contains("node_modules/pkg/index.js:1:"),
            "{}",
            r.content_text
        );
        let f = dispatch_find_files(&root, &json!({ "pattern": "*.js", "path": "node_modules" }));
        assert!(f.content_text.contains("node_modules/pkg/index.js"), "{}", f.content_text);
    }

    #[test]
    fn search_skips_oversized_files() {
        let (_d, root) = workspace();
        // A real match at the very start, then the file is stretched past
        // the size cap (sparse, so it costs no disk): the skip must be by
        // size, not by content.
        fs::write(root.join("big.log"), "needle\n").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(root.join("big.log"))
            .unwrap()
            .set_len(MAX_SEARCH_FILE_BYTES + 1)
            .unwrap();
        let r = dispatch_search_files(&root, &json!({ "pattern": "needle" }));
        assert!(r.content_text.contains("No matches"), "{}", r.content_text);
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
    fn write_over_a_crlf_file_keeps_crlf() {
        let (_d, root) = workspace();
        fs::write(root.join("win.txt"), "one\r\ntwo\r\n").unwrap();
        let r = dispatch_write_file(&root, &json!({ "path": "win.txt", "content": "x\ny\n" }));
        assert!(!r.is_error, "{}", r.content_text);
        assert_eq!(fs::read_to_string(root.join("win.txt")).unwrap(), "x\r\ny\r\n");
        // A new file takes the content as given.
        dispatch_write_file(&root, &json!({ "path": "fresh.txt", "content": "x\ny\n" }));
        assert_eq!(fs::read_to_string(root.join("fresh.txt")).unwrap(), "x\ny\n");
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

    /// `read_file` shows lines without `\r`, so the model's multi-line
    /// `old_text` arrives with bare `\n`. It must still match a CRLF file,
    /// and the file must still be CRLF afterwards.
    #[test]
    fn edit_matches_and_preserves_crlf_line_endings() {
        let (_d, root) = workspace();
        fs::write(root.join("win.txt"), "alpha\r\nbeta\r\ngamma\r\n").unwrap();
        let r = dispatch_edit_file(
            &root,
            &json!({ "path": "win.txt", "old_text": "alpha\nbeta", "new_text": "ALPHA\nBETA\nNEW" }),
        );
        assert!(!r.is_error, "{}", r.content_text);
        assert_eq!(
            fs::read_to_string(root.join("win.txt")).unwrap(),
            "ALPHA\r\nBETA\r\nNEW\r\ngamma\r\n"
        );
        // And an LF file is not converted.
        let lf = dispatch_edit_file(
            &root,
            &json!({ "path": "README.md", "old_text": "# Title\nsecond", "new_text": "# T\ns" }),
        );
        assert!(!lf.is_error, "{}", lf.content_text);
        assert_eq!(fs::read_to_string(root.join("README.md")).unwrap(), "# T\ns line\n");
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

    // ---- moving and deleting -------------------------------------------

    #[test]
    fn move_renames_files_and_directories_inside_the_root() {
        let (_d, root) = workspace();
        let r = dispatch_move_file(
            &root,
            &json!({ "from": "README.md", "to": "docs/intro.md" }),
        );
        assert!(!r.is_error, "{}", r.content_text);
        assert!(!root.join("README.md").exists());
        assert_eq!(
            fs::read_to_string(root.join("docs/intro.md")).unwrap(),
            "# Title\nsecond line\n"
        );
        assert!(r.content_text.contains("Moved `README.md` to `docs/intro.md`"));

        let d = dispatch_move_file(&root, &json!({ "from": "src", "to": "lib" }));
        assert!(!d.is_error, "{}", d.content_text);
        assert!(root.join("lib/main.rs").exists());
    }

    #[test]
    fn move_never_overwrites_and_refuses_nesting_into_itself() {
        let (_d, root) = workspace();
        let r = dispatch_move_file(
            &root,
            &json!({ "from": "README.md", "to": "src/main.rs" }),
        );
        assert!(r.is_error);
        assert!(r.content_text.contains("already exists"));
        assert!(root.join("README.md").exists());
        assert!(fs::read_to_string(root.join("src/main.rs")).unwrap().contains("fn main"));

        let nest = dispatch_move_file(&root, &json!({ "from": "src", "to": "src/inner" }));
        assert!(nest.is_error);
        assert!(nest.content_text.contains("inside itself"));

        let missing = dispatch_move_file(&root, &json!({ "from": "nope.txt", "to": "x.txt" }));
        assert!(missing.is_error);
    }

    #[test]
    fn delete_removes_a_file_or_an_empty_directory_only() {
        let (_d, root) = workspace();
        let r = dispatch_delete_file(&root, &json!({ "path": "README.md" }));
        assert!(!r.is_error, "{}", r.content_text);
        assert!(!root.join("README.md").exists());
        assert!(r.content_text.contains("Deleted `README.md`"));

        let full = dispatch_delete_file(&root, &json!({ "path": "src" }));
        assert!(full.is_error);
        assert!(full.content_text.contains("not empty"));
        assert!(root.join("src/main.rs").exists(), "a non-empty directory was removed");

        fs::create_dir(root.join("empty")).unwrap();
        let e = dispatch_delete_file(&root, &json!({ "path": "empty" }));
        assert!(!e.is_error, "{}", e.content_text);
        assert!(!root.join("empty").exists());

        let missing = dispatch_delete_file(&root, &json!({ "path": "gone.txt" }));
        assert!(missing.is_error);
    }

    // ---- approval policy -----------------------------------------------

    #[test]
    fn only_mutating_tools_require_approval() {
        assert!(requires_approval(WRITE_FILE));
        assert!(requires_approval(EDIT_FILE));
        assert!(requires_approval(MOVE_FILE));
        assert!(requires_approval(DELETE_FILE));
        assert!(!requires_approval(READ_FILE));
        assert!(!requires_approval(LIST_DIRECTORY));
        assert!(!requires_approval(FIND_FILES));
        assert!(!requires_approval(SEARCH_FILES));
    }

    // ---- project instructions ----

    #[test]
    fn instructions_are_absent_without_a_usable_loachfile() {
        let (_d, root) = workspace();
        assert_eq!(read_workspace_instructions(&root), None);

        // Blank is as good as missing: there is nothing to tell the model.
        fs::write(root.join(INSTRUCTIONS_FILE), "  \n\n").unwrap();
        assert_eq!(read_workspace_instructions(&root), None);

        // So is a directory that happens to carry the name.
        fs::remove_file(root.join(INSTRUCTIONS_FILE)).unwrap();
        fs::create_dir(root.join(INSTRUCTIONS_FILE)).unwrap();
        assert_eq!(read_workspace_instructions(&root), None);
    }

    #[test]
    fn instructions_come_back_verbatim_when_within_the_cap() {
        let (_d, root) = workspace();
        fs::write(
            root.join(INSTRUCTIONS_FILE),
            "# Project\r\n\r\nRun the tests before you edit.\r\n",
        )
        .unwrap();
        assert_eq!(
            read_workspace_instructions(&root).as_deref(),
            Some("# Project\r\n\r\nRun the tests before you edit.")
        );
    }

    #[test]
    fn oversized_instructions_are_clipped_on_a_char_boundary_with_a_note() {
        let (_d, root) = workspace();
        // Three-byte characters: the byte cap can't fall between them
        // evenly, so the clip has to cope with a split sequence.
        let big = "€".repeat(MAX_INSTRUCTIONS_BYTES);
        fs::write(root.join(INSTRUCTIONS_FILE), &big).unwrap();

        let out = read_workspace_instructions(&root).expect("present");
        let (body, note) = out
            .split_once("\n\n[")
            .expect("truncation note follows the body");
        assert!(
            body.len() <= MAX_INSTRUCTIONS_BYTES,
            "body over the cap: {} bytes",
            body.len()
        );
        assert!(body.chars().all(|c| c == '€'), "clip split a character");
        assert!(
            note.starts_with("LOACHFILE.md truncated by Loach at"),
            "{note:?}"
        );
    }

    /// Unix-only for the same reason as the tool symlink tests above.
    #[cfg(unix)]
    #[test]
    fn instructions_are_not_read_through_a_symlink_out_of_the_workspace() {
        let (_d, root) = workspace();
        let outside = tempfile::TempDir::new().unwrap();
        let secret = outside.path().join("notes.md");
        fs::write(&secret, "classified\n").unwrap();
        std::os::unix::fs::symlink(&secret, root.join(INSTRUCTIONS_FILE)).unwrap();
        assert_eq!(read_workspace_instructions(&root), None);
    }
}
