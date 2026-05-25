# Release notes

One markdown file per version, named `X.Y.Z.md` (matching the `version` field
in `package.json` / `tauri.conf.json` / `Cargo.toml` — no leading `v`).

The release workflow (`.github/workflows/release.yml`) reads the file matching
the merged version and uses its content as **both**:

- the GitHub release body, and
- the `notes` field inside `latest.json` (what users see in-app under
  Settings → Updates → "What's new").

Keeping them in sync means there's no post-publish edit step.

The macOS install / Gatekeeper-bypass instructions live in the top-level
`README.md` ("Install on macOS") — don't repeat them in per-release notes.

## How a release happens

1. On your dev branch, when the work is ready to ship:
   - bump the version in `package.json`, `src-tauri/tauri.conf.json`,
     `src-tauri/Cargo.toml`, and refresh `src-tauri/Cargo.lock`;
   - create `releases/X.Y.Z.md` with user-facing notes (markdown is fine —
     headings, lists, links all render in both places).
2. Merge the branch to `main`.
3. The workflow detects the new version + matching notes file and starts the
   build. If either is missing, the workflow silently skips — normal merges
   don't trigger anything.
4. When the build finishes, inspect the **draft** release on GitHub. Verify
   `latest.json` references `*.nsis.zip` (Windows), `*.AppImage` (Linux)
   and `*.app.tar.gz` (macOS) and that each entry has a non-empty
   signature.
5. Click **Publish release**. The in-app updater picks it up on next check.

## Style

Aim for user-facing language, not commit-message language. Compare:

- ❌ `Refactored useChatStore.resolveDefaultModelChoice to handle …`
- ✅ `New chats now remember your last-used model per provider.`

A 5–10 line summary is plenty. Group by **What's new** / **Fixes** /
**Breaking changes** if the release is meaty; skip the headings if it's a
small one.
