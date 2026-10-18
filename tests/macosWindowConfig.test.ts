// tauri.macos.conf.json is merged over tauri.conf.json with JSON Merge Patch
// (RFC 7396), which replaces arrays whole — so the macOS file repeats the
// entire `app.windows` entry, not just the title-bar keys it changes. Without
// this check, a size or flag changed in tauri.conf.json alone would quietly
// differ on macOS only, where nobody on the team can see it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

type WindowConfig = Record<string, unknown>;
type Conf = { app: { windows: WindowConfig[] } & Record<string, unknown> } & Record<string, unknown>;

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (file: string) =>
  JSON.parse(readFileSync(path.join(root, "src-tauri", file), "utf8")) as Conf;
const main = read("tauri.conf.json");
const mac = read("tauri.macos.conf.json");

/** The keys macOS changes: the system title bar, as an overlay. */
const TITLE_BAR_KEYS = ["decorations", "titleBarStyle", "hiddenTitle", "trafficLightPosition"];
const withoutTitleBar = (w: WindowConfig) =>
  Object.fromEntries(Object.entries(w).filter(([k]) => !TITLE_BAR_KEYS.includes(k)));

describe("macOS window config", () => {
  it("overrides nothing but the window list", () => {
    expect(Object.keys(mac).filter((k) => k !== "$schema")).toEqual(["app"]);
    expect(Object.keys(mac.app)).toEqual(["windows"]);
  });

  it("repeats every main window, changing only the title bar", () => {
    expect(mac.app.windows.map(withoutTitleBar)).toEqual(main.app.windows.map(withoutTitleBar));
    expect(mac.app.windows[0]).toMatchObject({
      decorations: true,
      titleBarStyle: "Overlay",
      hiddenTitle: true,
    });
  });
});
