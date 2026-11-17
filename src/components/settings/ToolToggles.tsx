//! Settings -> Tools: the catalogue of built-in tool switches.
//!
//! These fourteen rows are pure data, so they live as an array rendered by one
//! small component rather than as fourteen near-identical JSX blocks (which is
//! what they were, at roughly 400 lines).

import type { LucideIcon } from "lucide-react";
import type { Settings } from "@/types";
import { ArrowDownAZ, Binary, Braces, Calculator, CalendarClock, Diff, FileText, Fingerprint, FolderOpen, Globe, Hash, KeyRound, Network, Ruler, Terminal } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settingsStore";

/** Keys of `Settings` whose value is a boolean — the ones a Switch can drive. */
type BooleanSettingKey = {
  [K in keyof Settings]: Settings[K] extends boolean ? K : never;
}[keyof Settings];

/** Every entry in Settings → Tools. These rows are pure data — an icon, a
 *  title, some copy, and the boolean setting they drive — so they're listed
 *  here and rendered by {@link ToolToggleRow} rather than repeated as
 *  fourteen near-identical JSX blocks. Order is the order shown. */
export const TOOL_TOGGLES: {
  key: BooleanSettingKey;
  icon: LucideIcon;
  title: string;
  /** One-line summary for compact surfaces (the onboarding tools step).
   *  `description` below stays the full Settings copy. */
  blurb: string;
  description: React.ReactNode;
}[] = [
  {
    key: "web_fetch_enabled",
    icon: Globe,
    title: "Web fetch",
    blurb: "Read pages from URLs in your message",
    description: (
      <>
        When your message has a link in it, Loach downloads the page and adds
        its text to your message so the model can read it. Up to 5 links per
        message, 5&nbsp;MB and 30&nbsp;seconds each. Private network
        addresses are blocked.
      </>
    ),
  },
  {
    key: "calculate_tool_enabled",
    icon: Calculator,
    title: "Calculator",
    blurb: "Exact math instead of guessed arithmetic",
    description: (
      <>
        Lets the model do math exactly instead of guessing. Local models often
        get multi-step arithmetic wrong.
      </>
    ),
  },
  {
    key: "datetime_tool_enabled",
    icon: CalendarClock,
    title: "Date & time",
    blurb: "Date maths, timezones, business days",
    description: (
      <>
        Date math, time zones (daylight saving included), weekdays and
        business days, like "47 business days from today". Models often pick
        the wrong weekday or miscount.
      </>
    ),
  },
  {
    key: "count_tool_enabled",
    icon: Hash,
    title: "Count",
    blurb: "Exact character, word, and line counts",
    description: (
      <>
        Exact counts of characters, words, lines, or how often something
        appears. Fixes the "how many r's in strawberry" kind of mistake.
      </>
    ),
  },
  {
    key: "hash_tool_enabled",
    icon: Fingerprint,
    title: "Hash",
    blurb: "Real SHA-2 digests, never fabricated",
    description: (
      <>
        SHA-224, SHA-256, SHA-384 and SHA-512 hashes. Without it, models make
        up hashes that look right but aren't.
      </>
    ),
  },
  {
    key: "uuid_tool_enabled",
    icon: KeyRound,
    title: "UUID",
    blurb: "Generate real v4 / v7 UUIDs",
    description: (
      <>
        Real v4 (random) or v7 (time-ordered) UUIDs, up to 100 at a time,
        instead of made-up ones that can repeat.
      </>
    ),
  },
  {
    key: "base64_tool_enabled",
    icon: Binary,
    title: "Base64",
    blurb: "Encode and decode without garbling",
    description: (
      <>
        Base64 encoding and decoding, standard or URL-safe, without the
        padding mistakes models make by hand.
      </>
    ),
  },
  {
    key: "json_tool_enabled",
    icon: Braces,
    title: "JSON",
    blurb: "Validate, pretty-print, extract values",
    description: (
      <>
        Checks, formats and pulls values out of JSON. Catches almost-valid
        JSON, like trailing commas or curly quotes.
      </>
    ),
  },
  {
    key: "unit_convert_tool_enabled",
    icon: Ruler,
    title: "Unit conversion",
    blurb: "Exact factors, from km↔mi to parsecs",
    description: (
      <>
        Exact conversions for length, weight, temperature, volume, area,
        speed, time, energy and pressure, down to furlongs, troy ounces and
        parsecs.
      </>
    ),
  },
  {
    key: "diff_text_tool_enabled",
    icon: Diff,
    title: "Text diff",
    blurb: "Exact differences by line, word, or character",
    description: (
      <>
        Shows exactly what changed between two texts, by line, word or
        character. Models tend to miss small changes in long text.
      </>
    ),
  },
  {
    key: "sort_tool_enabled",
    icon: ArrowDownAZ,
    title: "Sort",
    blurb: "Lexical, natural, and numeric sorting",
    description: (
      <>
        Sorts lines alphabetically, by number, or naturally (file2 before
        file10), with options to reverse, drop duplicates and ignore case.
      </>
    ),
  },
  {
    key: "ip_tool_enabled",
    icon: Network,
    title: "IP / CIDR",
    blurb: "CIDR containment and subnet info",
    description: (
      <>
        Checks whether an address is in a range, like 10.0.5.7 in
        10.0.0.0/16, and works out subnet details such as the first and last
        usable address. IPv4 and IPv6.
      </>
    ),
  },
  {
    key: "pdf_tool_enabled",
    icon: FileText,
    title: "PDF",
    blurb: "Generate downloadable PDF documents",
    description: (
      <>
        Lets the model make a PDF with headings, paragraphs, lists, tables
        and page breaks, which you can open and download from its reply.
        Latin-script text only: Cyrillic, Greek, CJK and emoji show as{" "}
        <span className="font-mono">?</span>. No images yet.
      </>
    ),
  },
  {
    key: "workspace_tool_enabled",
    icon: FolderOpen,
    title: "Workspace files",
    blurb: "Let the model work in a folder you pick",
    description: (
      <>
        Lets the model read, search, create, edit, move and delete files in a
        folder you pick for a chat with the{" "}
        <span className="font-mono">+</span> button by the message box. It
        can't reach anything outside that folder. Every change asks you first
        unless you allow it for the chat (edits to the folder's instructions
        or <span className="font-mono">.git</span> always ask). Turns on by
        itself when you pick a folder. With a cloud provider, the files it
        reads are sent there.
      </>
    ),
  },
];

/** Settings → Tools → Run scripts. Not in `TOOL_TOGGLES`: onboarding offers
 *  those as in-process utilities, and its All ON preset would switch this
 *  on with them. Onboarding gives it its own row, outside the presets. */
export const RUN_SCRIPT_TOGGLE: (typeof TOOL_TOGGLES)[number] = {
  key: "run_script_enabled",
  icon: Terminal,
  title: "Run scripts",
  blurb: "Run code the model writes, asking every time",
  description: (
    <>
      Lets the model write a Python, bash, Node.js or PowerShell script and
      run it with what's installed on this computer, or run a script file
      from the chat's folder. Every run asks you first and shows the code and
      the command. A script runs as you, so it can reach any file and the
      network. Runs stop after 5 minutes. Not in Private Chat. Skill scripts
      have their own switch in Settings → Skills.
    </>
  ),
};

/** One row in Settings → Tools: icon, title, explanation, and the switch
 *  that flips its setting. Subscribes to just its own boolean so toggling
 *  one tool doesn't re-render the others. `children` are sub-options
 *  shown under the row. */
export function ToolToggleRow({
  tool,
  children,
}: {
  tool: (typeof TOOL_TOGGLES)[number];
  children?: React.ReactNode;
}) {
  const enabled = useSettingsStore((s) => s[tool.key]);
  const update = useSettingsStore((s) => s.update);
  const Icon = tool.icon;
  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor={`setting-${tool.key}`} className="flex items-center gap-1.5">
            <Icon className="h-3.5 w-3.5 text-foreground/60" />
            {tool.title}
          </Label>
          <p className="mt-1 text-[11px] text-foreground/50">
            {tool.description}
          </p>
        </div>
        <Switch id={`setting-${tool.key}`}
          checked={enabled}
          onCheckedChange={(next) => void update(tool.key, next)}
          className="shrink-0"
          // A stable name: the switch announces its own state. "Enable X"
          // / "Disable X" flipped with it, and read as the opposite.
          aria-label={tool.title}
        />
      </div>
      {children}
    </div>
  );
}

/** Sub-option of Workspace files: whether a folder without a LOACHFILE.md
 *  borrows the CLAUDE.md or AGENTS.md it keeps for another coding agent.
 *  Not in `TOOL_TOGGLES`, which onboarding also offers as tools. Left
 *  switchable while Workspace files is off, since picking a folder turns
 *  that on. */
export function InstructionsFallbackToggle() {
  const enabled = useSettingsStore((s) => s.workspace_instructions_fallback);
  const update = useSettingsStore((s) => s.update);
  return (
    <div className="mt-3 ml-5 flex items-start justify-between gap-4 border-l border-foreground/10 pl-3">
      <div className="min-w-0">
        <Label htmlFor="setting-instructions-fallback">Use CLAUDE.md or AGENTS.md</Label>
        <p className="mt-1 text-[11px] text-foreground/50">
          The model gets the folder's{" "}
          <span className="font-mono">LOACHFILE.md</span> as project
          instructions. If there isn't one, it gets{" "}
          <span className="font-mono">CLAUDE.md</span> or{" "}
          <span className="font-mono">AGENTS.md</span> instead (made for Claude
          Code and Codex). Turn off if they mention tools Loach doesn't have.
        </p>
      </div>
      <Switch id="setting-instructions-fallback"
        checked={enabled}
        onCheckedChange={(next) => void update("workspace_instructions_fallback", next)}
        className="shrink-0"
        aria-label={
          enabled
            ? "Stop using CLAUDE.md or AGENTS.md as project instructions"
            : "Use CLAUDE.md or AGENTS.md as project instructions"
        }
      />
    </div>
  );
}
