# Icons

The bundle icons listed under `bundle.icon` in `tauri.conf.json`:

- `32x32.png` (also the window and tray icon on Linux: the first PNG in the list)
- `128x128.png`
- `128x128@2x.png`
- `icon.icns` (macOS)
- `icon.ico` (Windows; also the window and tray icon there)

Plus `tray-template.png`, the macOS menu-bar icon (a template image, so the
system tints it), embedded by `src/lib.rs`.

Regenerate the bundle icons from the 1024x1024 `source.png` with:

```bash
npm run tauri icon icons/source.png
```

`tauri icon` also writes Android, iOS, Windows Store (`Square*Logo.png`,
`StoreLogo.png`) and extra PNG sizes. Loach ships none of those targets, so
delete them after regenerating rather than committing them.
