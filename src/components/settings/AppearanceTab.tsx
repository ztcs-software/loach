//! Settings -> Appearance: theme, colour mode, and font size.

import { AppearanceTile, ColorModePreview, ThemePreview, resolveMode } from "./appearance";
import { FontSizeSwitch } from "./switches";
import { Label } from "@/components/ui/label";
import { SectionTitle } from "./shared";
import { Separator } from "@/components/ui/separator";
import { useSettingsStore } from "@/stores/settingsStore";

export function AppearanceTab() {
  const settings = useSettingsStore();
  return (
    <>
                <SectionTitle>Appearance</SectionTitle>

                {/* ── Theme: Solid vs Aurora ────────────────────────────
                     Naming note: we keep the persisted value names
                     ("solid" / "gradient") unchanged for backwards
                     compatibility with the SQLite KV store and only
                     relabel in the UI ("Aurora" is the glass-mesh look). */}
                <div>
                  <Label>Theme</Label>
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <AppearanceTile
                      title="Solid"
                      selected={settings.background_style === "solid"}
                      onClick={() => settings.update("background_style", "solid")}
                    >
                      <ThemePreview variant="solid" mode={resolveMode(settings.theme)} />
                    </AppearanceTile>
                    <AppearanceTile
                      title="Aurora"
                      selected={settings.background_style === "gradient"}
                      onClick={() => settings.update("background_style", "gradient")}
                    >
                      <ThemePreview variant="gradient" mode={resolveMode(settings.theme)} />
                    </AppearanceTile>
                  </div>
                </div>

                <Separator />

                {/* ── Color mode: Light / System / Dark ───────────────── */}
                <div>
                  <Label>Color mode</Label>
                  <div className="mt-3 grid grid-cols-3 gap-3">
                    <AppearanceTile
                      title="Light"
                      selected={settings.theme === "light"}
                      onClick={() => settings.update("theme", "light")}
                    >
                      <ColorModePreview mode="light" variant={settings.background_style} />
                    </AppearanceTile>
                    <AppearanceTile
                      title="System"
                      selected={settings.theme === "system"}
                      onClick={() => settings.update("theme", "system")}
                    >
                      <ColorModePreview mode="system" variant={settings.background_style} />
                    </AppearanceTile>
                    <AppearanceTile
                      title="Dark"
                      selected={settings.theme === "dark"}
                      onClick={() => settings.update("theme", "dark")}
                    >
                      <ColorModePreview mode="dark" variant={settings.background_style} />
                    </AppearanceTile>
                  </div>
                </div>

                <Separator />

                {/* ── Font size: Small / Normal / Large ────────────────── */}
                <div>
                  <Label>Font size</Label>
                  <FontSizeSwitch
                    value={settings.font_size}
                    onChange={(next) => settings.update("font_size", next)}
                  />
                </div>

    </>
  );
}
