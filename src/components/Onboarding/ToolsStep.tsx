import { useRef, useState } from "react";
import { ChevronDown, Globe, Plug, Wrench } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settingsStore";
import { useOnboardingStore } from "@/stores/onboardingStore";
import { TOOL_TOGGLES } from "@/components/settings/ToolToggles";
import { cn } from "@/lib/utils";
import { StepShell } from "./StepShell";

/**
 * Tools step. Loach ships thirteen tools the model can call, and before this
 * screen existed every one of them was discover-by-accident — buried in
 * Settings → Tools with nothing in the product pointing there.
 *
 * The utility tools open pre-set to a recommended selection (everything on
 * except the niche developer four: hash, UUID, base64, IP/CIDR), switchable
 * per tool or via the All OFF / Recommended / All ON presets. Because the
 * screen now *shows* a selection, the write rules are:
 *
 *   - **Continue** commits the utilities exactly as displayed — what you see
 *     is what you get.
 *   - **Skip** writes only what the user explicitly flipped. Skipping past
 *     is not consent to the recommended set.
 *   - **Web fetch** starts off regardless and is only ever written when
 *     touched. It is the one network-reaching switch in the app, and no
 *     default or preset may opt someone into networking.
 *
 * MCP gets a row with no switch — connecting a server needs a command,
 * arguments and env, which is a Settings-sized job, not a wizard-sized one.
 */

/** The in-process tools, i.e. everything in Settings → Tools except web
 *  fetch (which gets its own row above, being the only one that opens a
 *  socket). Derived from the same array Settings renders so the two can't
 *  drift as tools are added. */
const UTILITY_TOOLS = TOOL_TOGGLES.filter((t) => t.key !== "web_fetch_enabled");

type UtilityKey = (typeof UTILITY_TOOLS)[number]["key"];

/** Off in the recommended preset: the four whose outputs only a developer
 *  asks for. Everything else earns its catalogue slot for general chat. */
const RECOMMENDED_OFF = new Set<UtilityKey>([
  "hash_tool_enabled",
  "uuid_tool_enabled",
  "base64_tool_enabled",
  "ip_tool_enabled",
]);

const RECOMMENDED: Record<string, boolean> = Object.fromEntries(
  UTILITY_TOOLS.map((t) => [t.key, !RECOMMENDED_OFF.has(t.key)]),
);

type Preset = "off" | "recommended" | "on";

export function ToolsStep({ onClose }: { onClose: () => void }) {
  const update = useSettingsStore((s) => s.update);
  const goNext = useOnboardingStore((s) => s.goNext);
  const goBack = useOnboardingStore((s) => s.goBack);

  const [webFetch, setWebFetch] = useState(false);
  const [tools, setTools] = useState<Record<string, boolean>>(RECOMMENDED);
  const [utilitiesOpen, setUtilitiesOpen] = useState(true);

  const webFetchTouched = useRef(false);
  // Which utilities the user explicitly set (individually or via a preset) —
  // the only ones Skip persists.
  const touchedTools = useRef(new Set<UtilityKey>());

  const setTool = (key: UtilityKey, v: boolean) => {
    touchedTools.current.add(key);
    setTools((t) => ({ ...t, [key]: v }));
  };

  const applyPreset = (preset: Preset) => {
    const next: Record<string, boolean> = {};
    for (const t of UTILITY_TOOLS) {
      touchedTools.current.add(t.key);
      next[t.key] =
        preset === "on" ? true : preset === "off" ? false : RECOMMENDED[t.key];
    }
    setTools(next);
  };

  const onCount = UTILITY_TOOLS.filter((t) => tools[t.key]).length;
  const activePreset: Preset | null =
    onCount === 0
      ? "off"
      : onCount === UTILITY_TOOLS.length
        ? "on"
        : UTILITY_TOOLS.every((t) => !!tools[t.key] === RECOMMENDED[t.key])
          ? "recommended"
          : null;

  const commit = async (opts: { full: boolean }) => {
    const writes: Promise<void>[] = [];
    if (webFetchTouched.current) {
      writes.push(update("web_fetch_enabled", webFetch));
    }
    for (const tool of UTILITY_TOOLS) {
      if (opts.full || touchedTools.current.has(tool.key)) {
        writes.push(update(tool.key, tools[tool.key] ?? false));
      }
    }
    await Promise.all(writes);
    goNext();
  };

  return (
    <StepShell
      step="tools"
      title="Give the model some tools"
      subtitle="Optional. A recommended set is pre-selected — adjust what you like. Change any of it later in Settings → Tools."
      onPrimary={() => void commit({ full: true })}
      skippable
      onSkip={() => void commit({ full: false })}
      canGoBack
      onBack={goBack}
      onClose={onClose}
    >
      <div className="space-y-2">
        <ToolRow
          icon={<Globe className="h-4 w-4" />}
          title="Web fetch"
          description="When your message contains an http(s):// URL, Loach downloads the page and inlines the readable text so the model can read it. This is the only feature that reaches the network on your behalf."
          checked={webFetch}
          onChange={(v) => {
            webFetchTouched.current = true;
            setWebFetch(v);
          }}
        />

        {/* No switch: an MCP server needs a command, args and environment. */}
        <div className="flex items-start gap-3 rounded-xl border border-dashed border-foreground/[0.10] bg-foreground/[0.01] p-3.5">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.05] text-foreground/60">
            <Plug className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-foreground/85">
              MCP servers
            </p>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-foreground/55">
              Connect external Model Context Protocol servers to give the model
              your own tools — filesystem access, databases, anything with an
              MCP adapter. Set them up in Settings → MCP when you're ready.
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-foreground/[0.06] bg-foreground/[0.015] p-3.5 transition-colors hover:bg-foreground/[0.025]">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.05] text-foreground/75">
              <Wrench className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium">Tools</p>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-foreground/55">
                Exact answers for the things language models reliably get wrong
                — arithmetic, dates, hashes, unit conversion, JSON, diffs, and
                more.
              </p>
            </div>
            <PresetPicker active={activePreset} onPick={applyPreset} />
          </div>
          {utilitiesOpen && (
            <div className="mt-3 divide-y divide-foreground/[0.05] border-t border-foreground/[0.06]">
              {UTILITY_TOOLS.map((t) => {
                const Icon = t.icon;
                const on = !!tools[t.key];
                return (
                  <div key={t.key} className="flex items-center gap-2.5 py-2">
                    <Icon className="h-4 w-4 shrink-0 text-foreground/55" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12.5px] text-foreground/85">
                        {t.title}
                      </p>
                      <p className="truncate text-[11px] text-foreground/45">
                        {t.blurb}
                      </p>
                    </div>
                    <Switch
                      checked={on}
                      onCheckedChange={(v) => setTool(t.key, v)}
                      aria-label={on ? t.ariaOff : t.ariaOn}
                      className="shrink-0"
                    />
                  </div>
                );
              })}
            </div>
          )}
          {/* Expand control at the tile's bottom edge, full width so it
              doubles as the card's footer. Carries the count so a collapsed
              card never hides how many tools are on. */}
          <button
            type="button"
            aria-expanded={utilitiesOpen}
            onClick={() => setUtilitiesOpen((v) => !v)}
            className="mt-3 flex w-full items-center justify-center gap-1.5 border-t border-foreground/[0.06] pt-2.5 text-[11.5px] text-foreground/55 transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                utilitiesOpen ? "rotate-180" : "rotate-0",
              )}
            />
            {utilitiesOpen
              ? "Hide tools"
              : `Show tools · ${onCount} of ${UTILITY_TOOLS.length} on`}
          </button>
        </div>
      </div>
    </StepShell>
  );
}

/** All OFF / Recommended / All ON segmented control. Same aria-pressed pill
 *  idiom as ProviderSwitch; no option is marked active while the individual
 *  switches sit in a mix that matches none of the presets. */
function PresetPicker({
  active,
  onPick,
}: {
  active: Preset | null;
  onPick: (p: Preset) => void;
}) {
  const options: { id: Preset; label: string }[] = [
    { id: "off", label: "All OFF" },
    { id: "recommended", label: "Recommended" },
    { id: "on", label: "All ON" },
  ];
  return (
    <div className="mt-0.5 inline-flex shrink-0 gap-1 rounded-full border border-foreground/[0.08] bg-foreground/[0.03] p-0.5">
      {options.map((o) => {
        const isActive = o.id === active;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={isActive}
            onClick={() => onPick(o.id)}
            className={cn(
              "rounded-full px-2 py-0.5 text-[10.5px] font-medium transition-colors",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
              isActive
                ? "bg-foreground/[0.10] text-foreground"
                : "text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/85",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function ToolRow({
  icon,
  title,
  description,
  checked,
  onChange,
}: {
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-foreground/[0.06] bg-foreground/[0.015] p-3.5 transition-colors hover:bg-foreground/[0.025]">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.05] text-foreground/75">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">{title}</p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-foreground/55">
          {description}
        </p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        aria-label={checked ? `Disable ${title}` : `Enable ${title}`}
        className="mt-1 shrink-0"
      />
    </div>
  );
}
