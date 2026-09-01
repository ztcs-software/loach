//! Settings -> Tools: the catalogue of built-in tool switches.
//!
//! These thirteen rows are pure data, so they live as an array rendered by one
//! small component rather than as thirteen near-identical JSX blocks (which is
//! what they were, at roughly 400 lines).

import type { LucideIcon } from "lucide-react";
import type { Settings } from "@/types";
import { ArrowDownAZ, Binary, Braces, Calculator, CalendarClock, Diff, FileText, Fingerprint, Globe, Hash, KeyRound, Network, Ruler } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settingsStore";


type BooleanSettingKey = {
  [K in keyof Settings]: Settings[K] extends boolean ? K : never;
}[keyof Settings];

/** Every entry in Settings → Tools. These rows are pure data — an icon, a
 *  title, some copy, and the boolean setting they drive — so they're listed
 *  here and rendered by {@link ToolToggleRow} rather than repeated as
 *  thirteen near-identical JSX blocks. Order is the order shown. */
export const TOOL_TOGGLES: {
  key: BooleanSettingKey;
  icon: LucideIcon;
  title: string;
  /** One-line summary for compact surfaces (the onboarding tools step).
   *  `description` below stays the full Settings copy. */
  blurb: string;
  /** Verb phrase for the switch's accessible name in each direction. */
  ariaOn: string;
  ariaOff: string;
  description: React.ReactNode;
}[] = [
  {
    key: "web_fetch_enabled",
    icon: Globe,
    title: "Web fetch",
    blurb: "Read pages from URLs in your message",
    ariaOn: "Enable web fetch",
    ariaOff: "Disable web fetch",
    description: (
      <>
        When your message contains an{" "}
        <span className="font-mono">http(s)://</span> URL,
        Loach downloads the page, extracts the readable text,
        and appends it to the prompt so the model can read it.
        Up to 5 URLs per message, 5&nbsp;MB each, 30&nbsp;s
        timeout. Private IPs are blocked.
      </>
    ),
  },
  {
    key: "calculate_tool_enabled",
    icon: Calculator,
    title: "Calculator",
    blurb: "Exact math instead of guessed arithmetic",
    ariaOn: "Enable calculator tool",
    ariaOff: "Disable calculator tool",
    description: (
      <>
        Exposes a built-in{" "}
        <span className="font-mono">calculate</span> tool the
        model can call mid-response to evaluate math
        expressions. Local models often miscalculate
        multi-step arithmetic; this gives them an exact
        answer instead. Runs entirely in-process — no
        network — and is available even in Private Chat.
      </>
    ),
  },
  {
    key: "datetime_tool_enabled",
    icon: CalendarClock,
    title: "Date & time",
    blurb: "Date maths, timezones, business days",
    ariaOn: "Enable datetime tool",
    ariaOff: "Disable datetime tool",
    description: (
      <>
        Exposes a{" "}
        <span className="font-mono">datetime</span> tool for
        parsing, formatting, and arithmetic on dates — DST-aware
        timezone conversion, "47 business days from today",
        weekday lookup. Local models pick wrong weekdays and
        miscount business days; chrono is exact. In-process.
      </>
    ),
  },
  {
    key: "count_tool_enabled",
    icon: Hash,
    title: "Count",
    blurb: "Exact character, word, and line counts",
    ariaOn: "Enable count tool",
    ariaOff: "Disable count tool",
    description: (
      <>
        Exposes a <span className="font-mono">count</span>{" "}
        tool for exact character / byte / word / line /
        substring counts. Tokenization hides character
        identity from the model — this fixes the "how many
        r's in strawberry" class of failure. In-process.
      </>
    ),
  },
  {
    key: "hash_tool_enabled",
    icon: Fingerprint,
    title: "Hash",
    blurb: "Real SHA-2 digests, never fabricated",
    ariaOn: "Enable hash tool",
    ariaOff: "Disable hash tool",
    description: (
      <>
        Exposes a <span className="font-mono">hash</span>{" "}
        tool for SHA-224 / SHA-256 / SHA-384 / SHA-512
        digests over UTF-8, hex, or base64 input. Models
        will fabricate a digest that looks plausible but
        isn't — this gives an exact one. In-process.
      </>
    ),
  },
  {
    key: "uuid_tool_enabled",
    icon: KeyRound,
    title: "UUID",
    blurb: "Generate real v4 / v7 UUIDs",
    ariaOn: "Enable uuid tool",
    ariaOff: "Disable uuid tool",
    description: (
      <>
        Exposes a <span className="font-mono">uuid</span>{" "}
        tool that generates v4 (random) or v7
        (time-ordered) UUIDs, up to 100 per call. Models
        will hallucinate UUID-shaped strings that
        eventually collide — this generates real ones.
        In-process.
      </>
    ),
  },
  {
    key: "base64_tool_enabled",
    icon: Binary,
    title: "Base64",
    blurb: "Encode and decode without garbling",
    ariaOn: "Enable base64 tool",
    ariaOff: "Disable base64 tool",
    description: (
      <>
        Exposes a <span className="font-mono">base64</span>{" "}
        tool for standard / URL-safe encode and decode.
        Models routinely garble padding or mix alphabets —
        this just does it right. In-process.
      </>
    ),
  },
  {
    key: "json_tool_enabled",
    icon: Braces,
    title: "JSON",
    blurb: "Validate, pretty-print, extract values",
    ariaOn: "Enable json tool",
    ariaOff: "Disable json tool",
    description: (
      <>
        Exposes a <span className="font-mono">json</span>{" "}
        tool that pretty-prints, validates, or extracts a
        value at a JSON Pointer path. Catches the
        almost-valid JSON (trailing commas, smart quotes)
        models like to produce. In-process.
      </>
    ),
  },
  {
    key: "unit_convert_tool_enabled",
    icon: Ruler,
    title: "Unit conversion",
    blurb: "Exact factors, from km↔mi to parsecs",
    ariaOn: "Enable unit conversion tool",
    ariaOff: "Disable unit conversion tool",
    description: (
      <>
        Exposes a{" "}
        <span className="font-mono">unit_convert</span> tool
        with a curated factor table for length, mass,
        temperature, volume, area, speed, time, energy,
        and pressure — including uncommon units like
        furlong, troy ounce, parsec. Models hallucinate
        factors for anything past km↔mi. In-process.
      </>
    ),
  },
  {
    key: "diff_text_tool_enabled",
    icon: Diff,
    title: "Text diff",
    blurb: "Unified diffs by line, word, or character",
    ariaOn: "Enable text diff tool",
    ariaOff: "Disable text diff tool",
    description: (
      <>
        Exposes a <span className="font-mono">diff_text</span>{" "}
        tool that computes a unified diff between two
        strings, by line, word, or character. Models try
        to eyeball diffs and miss small changes in long
        inputs. In-process.
      </>
    ),
  },
  {
    key: "sort_tool_enabled",
    icon: ArrowDownAZ,
    title: "Sort",
    blurb: "Lexical, natural, and numeric sorting",
    ariaOn: "Enable sort tool",
    ariaOff: "Disable sort tool",
    description: (
      <>
        Exposes a <span className="font-mono">sort</span>{" "}
        tool for lexical, natural, and numeric line sort
        with reverse / unique / case-insensitive flags.
        Natural sort (file1, file2, file10 — not file1,
        file10, file2) is easy to get wrong by hand.
        In-process.
      </>
    ),
  },
  {
    key: "ip_tool_enabled",
    icon: Network,
    title: "IP / CIDR",
    blurb: "CIDR containment and subnet info",
    ariaOn: "Enable IP / CIDR tool",
    ariaOff: "Disable IP / CIDR tool",
    description: (
      <>
        Exposes an <span className="font-mono">ip</span>{" "}
        tool for CIDR containment ("does 10.0.5.7 fall in
        10.0.0.0/16?") and subnet info (network,
        broadcast, first/last usable host, total). IPv4
        and IPv6. Easy to get wrong on /23, /127, or
        anything past a /24. In-process.
      </>
    ),
  },
  {
    key: "pdf_tool_enabled",
    icon: FileText,
    title: "PDF",
    blurb: "Generate downloadable PDF documents",
    ariaOn: "Enable PDF tool",
    ariaOff: "Disable PDF tool",
    description: (
      <>
        Exposes a <span className="font-mono">pdf</span>{" "}
        tool the model can call to produce a downloadable
        PDF from a structured spec — headings, paragraphs,
        bullet / numbered lists, horizontal rules, page
        breaks, and simple tables. The result attaches to
        the assistant message and opens in the built-in
        viewer. Renders Unicode text (Latin, European
        accents, common punctuation and currency) via a
        bundled font; characters outside that set (e.g.
        CJK, emoji) become <span className="font-mono">?</span>.
        Image blocks and merging existing PDFs aren't
        supported yet. In-process.
      </>
    ),
  },
];

/** One row in Settings → Tools: icon, title, explanation, and the switch
 *  that flips its setting. Subscribes to just its own boolean so toggling
 *  one tool doesn't re-render the other twelve. */
export function ToolToggleRow({ tool }: { tool: (typeof TOOL_TOGGLES)[number] }) {
  const enabled = useSettingsStore((s) => s[tool.key]);
  const update = useSettingsStore((s) => s.update);
  const Icon = tool.icon;
  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Label className="flex items-center gap-1.5">
            <Icon className="h-3.5 w-3.5 text-foreground/60" />
            {tool.title}
          </Label>
          <p className="mt-1 text-[11px] text-foreground/50">
            {tool.description}
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(next) => void update(tool.key, next)}
          className="shrink-0"
          aria-label={enabled ? tool.ariaOff : tool.ariaOn}
        />
      </div>
    </div>
  );
}
