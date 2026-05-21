import type { LucideIcon } from "lucide-react";
import {
  Briefcase,
  HeartHandshake,
  HelpCircle,
  Library,
  MessageCircle,
  Scale,
  Smile,
  Sparkles,
  Target,
} from "lucide-react";

export interface Tone {
  id: string;
  label: string;
  description: string;
  // Appended verbatim after the persona / global system prompt so the model
  // sees role first, style second. Empty for the default tone — picking
  // "Default" means "don't append anything".
  systemPrompt: string;
  icon: LucideIcon;
}

export const DEFAULT_TONE_ID = "default";

export const TONES: Tone[] = [
  {
    id: DEFAULT_TONE_ID,
    label: "Default",
    description: "Model's natural voice — no style override.",
    systemPrompt: "",
    icon: Sparkles,
  },
  {
    id: "direct",
    label: "Direct",
    description: "Lead with the point. No padding, no softeners.",
    systemPrompt:
      "Style guidance: get to the point and stay there. Skip preamble, restatements, and throat-clearing. Lead with the answer; expand only if asked. Drop softeners like \"might,\" \"perhaps,\" and \"I think\" unless the uncertainty is real. State conclusions plainly, including critical ones — no diplomatic padding before bad news.",
    icon: Target,
  },
  {
    id: "detailed",
    label: "Detailed",
    description: "Thorough coverage with caveats and reasoning.",
    systemPrompt:
      "Style guidance: be thorough. Cover edge cases, caveats, and the reasoning behind your answer. Prefer completeness over brevity. Use structure (lists, headings) when it aids comprehension.",
    icon: Library,
  },
  {
    id: "casual",
    label: "Casual",
    description: "Plain English, conversational.",
    systemPrompt:
      "Style guidance: speak conversationally in plain English. Contractions are fine. Avoid corporate or academic register. Keep it human.",
    icon: MessageCircle,
  },
  {
    id: "formal",
    label: "Formal",
    description: "Professional register suitable for business writing.",
    systemPrompt:
      "Style guidance: write in a professional register suitable for business communication. Use full sentences and avoid slang or contractions. Maintain a measured, courteous tone.",
    icon: Briefcase,
  },
  {
    id: "encouraging",
    label: "Encouraging",
    description: "Supportive framing — useful for learners and first drafts.",
    systemPrompt:
      "Style guidance: frame feedback constructively. Acknowledge what's working before correcting what isn't. Keep critique specific and kind. Useful when the user is learning or sharing a draft.",
    icon: HeartHandshake,
  },
  {
    id: "playful",
    label: "Playful",
    description: "Light wit and personality. Humor in service of clarity.",
    systemPrompt:
      "Style guidance: let some personality through. Light wit, the occasional aside, and informal phrasing are welcome. Don't force jokes or sacrifice clarity for cleverness — humor serves the answer, not the other way around.",
    icon: Smile,
  },
  {
    id: "skeptical",
    label: "Skeptical",
    description: "Stress-tests claims and surfaces counterarguments.",
    systemPrompt:
      "Style guidance: stress-test the user's reasoning. Surface counterarguments, edge cases, and assumptions they may be skipping. Push back when claims are weakly supported. Be rigorous, not contrarian — agree when agreement is warranted.",
    icon: Scale,
  },
  {
    id: "socratic",
    label: "Socratic",
    description: "Guides with questions instead of handing over answers.",
    systemPrompt:
      "Style guidance: answer with guiding questions rather than conclusions when the user seems to be working something out. Surface assumptions, ask what they've tried, and push them toward the answer instead of handing it over. Switch to direct answers when they explicitly ask for one.",
    icon: HelpCircle,
  },
];

export function getTone(id: string | undefined | null): Tone | null {
  if (!id) return null;
  return TONES.find((t) => t.id === id) ?? null;
}
