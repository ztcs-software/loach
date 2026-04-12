# Icons

Place the following Tauri bundle icons here before running `tauri build`:

- `32x32.png`
- `128x128.png`
- `128x128@2x.png`
- `icon.icns` (macOS, not strictly required for Windows/Linux targets)
- `icon.ico` (Windows)
- `icon.png` (tray icon, 256x256 recommended)

You can generate these from a single 1024x1024 source image with:

```bash
npm run tauri icon path/to/source.png
```
