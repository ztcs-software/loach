import { useRef, useState } from "react";
import { Globe, Plug, Wrench } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settingsStore";
import { useOnboardingStore } from "@/stores/onboardingStore";
import { TOOL_TOGGLES } from "@/components/settings/ToolToggles";
import { StepShell } from "./StepShell";

/**
 * Tools step. Loach ships thirteen tools the model can call, all off by
 * default, and before this screen existed every one of them was
 * discover-by-accident — buried in Settings → Tools with nothing in the
 * product pointing there.
 *
 * The screen's job is disclosure, not persuasion, so everything here starts
 * OFF (matching the app's own defaults) and **nothing is written unless the
 * user actually flips it**. Two reasons for that stricter rule than the
 * Features step uses:
 *
 *   - Web fetch is the one network-touching switch in the app. Pressing Skip
 *     without reading is not consent to networking.
 *   - The utility tools are off by design, not by oversight: every enabled
 *     tool is another entry in the catalogue shipped to the model, and small
 *     local models degrade when that list grows. Turning on thirteen tools
 *     for a user who skipped past would quietly hurt their output quality.
 *
 * MCP gets a row with no switch — connecting a server needs a command,
 * arguments and env, which is a Settings-sized job, not a wizard-sized one.
 */

/** The in-process tools, i.e. everything in Settings → Tools except web
 *  fetch (which gets its own row above, being the only one that opens a
 *  socket). Derived from the same array Settings renders so the two can't
 *  drift as tools are added. */
const UTILITY_TOOLS = TOOL_TOGGLES.filter((t) => t.key !== "web_fetch_enabled");

export function ToolsStep({ onClose }: { onClose: () => void }) {
  const update = useSettingsStore((s) => s.update);
  const goNext = useOnboardingStore((s) => s.goNext);
  const goBack = useOnboardingStore((s) => s.goBack);

  const [webFetch, setWebFetch] = useState(false);
  const [utilities, setUtilities] = useState(false);

  // Only settings the user actually touched are written — see the header note.
  const webFetchTouched = useRef(false);
  const utilitiesTouched = useRef(false);

  const commit = async () => {
    const writes: Promise<void>[] = [];
    if (webFetchTouched.current) {
      writes.push(update("web_fetch_enabled", webFetch));
    }
    if (utilitiesTouched.current) {
      for (const tool of UTILITY_TOOLS) {
        writes.push(update(tool.key, utilities));
      }
    }
    await Promise.all(writes);
    goNext();
  };

  return (
    <StepShell
      step="tools"
      title="Give the model some tools"
      subtitle="Optional. All off to start — turn on what you need, and fine-tune individual tools later in Settings → Tools."
      onPrimary={() => void commit()}
      skippable
      onSkip={() => void commit()}
      canGoBack
      onBack={goBack}
      onClose={onClose}
    >
      <div className="space-y-2">
        <ToolRow
          icon={<Globe className="h-4 w-4" />}
          title="Web fetch"
          description="When your message contains an http(s):// URL, Loach downloads the page and inlines the readable text so the model can read it. Up to 5 URLs per message, 5 MB each; private IPs are blocked. This is the only feature that reaches the network on your behalf."
          checked={webFetch}
          onChange={(v) => {
            webFetchTouched.current = true;
            setWebFetch(v);
          }}
        />

        <ToolRow
          icon={<Wrench className="h-4 w-4" />}
          title={`Built-in utilities (${UTILITY_TOOLS.length})`}
          description={
            <>
              Exact answers for the things language models reliably get wrong —
              arithmetic, character counts, date maths, hashes, UUIDs, unit
              conversion, JSON, diffs, sorting, IP ranges, and PDF generation.
              All run in-process: no network, no file access.
              <span className="mt-1 block text-foreground/45">
                {UTILITY_TOOLS.map((t) => t.title).join(" · ")}
              </span>
            </>
          }
          checked={utilities}
          onChange={(v) => {
            utilitiesTouched.current = true;
            setUtilities(v);
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
      </div>
    </StepShell>
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
