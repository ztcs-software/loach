# Release notes

One markdown file per version, named `X.Y.Z.md` (matching the `version` field
in `package.json` / `tauri.conf.json` / `Cargo.toml` — no leading `v`).

The release workflow (`.github/workflows/release.yml`) reads the file matching
the merged version and uses its content as **both**:

- the GitHub release body, and
- the `notes` field inside `latest.json` (what users see in-app under
  Settings → Updates → "Release notes").

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
4. When the build finishes, inspect the **draft** release on GitHub. Open
   `latest.json` from the assets and check every platform entry points at the
   right artifact, each with a non-empty base64 `signature`. The `url`s are
   GitHub API asset links (`api.github.com/.../releases/assets/<id>`) that
   don't name the file, so read the artifact from the signature instead:
   base64-decode it (PowerShell:
   `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($sig))`) and
   check the `file:` field on its `trusted comment:` line:

   | key | `file:` |
   | --- | --- |
   | `windows-x86_64`, `windows-x86_64-nsis` | `*-setup.exe` |
   | `linux-x86_64`, `linux-x86_64-appimage` | `*.AppImage` |
   | `linux-x86_64-deb` | `*.deb` |
   | `linux-x86_64-rpm` | `*.rpm` |
   | `darwin-aarch64`, `darwin-aarch64-app` | `*.app.tar.gz` |

   The plain `linux-x86_64` key **must** be the AppImage, never the `.deb` or
   `.rpm`: installs running updater plugin < 2.10 only look up that key, and
   handing them a package file breaks their in-place update. The `.dmg`
   uploads for manual install only — the updater can't patch it, so it never
   appears in `latest.json`. (v1.2.3 is the reference set of keys to diff
   against.)
5. Click **Publish release**. The in-app updater picks it up on next check —
   unless the version has a pre-release suffix (`-beta-1`, `-rc-1`): those
   publish as GitHub pre-releases, which the updater's `releases/latest`
   endpoint skips.

## Style

Aim for user-facing language, not commit-message language. Compare:

- ❌ `Refactored useChatStore.resolveDefaultModelChoice to handle …`
- ✅ `New chats now remember your last-used model per provider.`

A 5–10 line summary is plenty. Group by **What's new** / **Fixes** /
**Breaking changes** if the release is meaty; skip the headings if it's a
small one.
