import type { LucideIcon } from "lucide-react";
import {
  Briefcase,
  HeartHandshake,
  Library,
  MessageCircle,
  Minimize2,
  Sparkles,
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
    id: "concise",
    label: "Concise",
    description: "Short answers. Lead with the point, no preamble.",
    systemPrompt:
      "Style guidance: keep responses tight. Skip preamble and throat-clearing. Lead with the answer; expand only if asked. Prefer short sentences.",
    icon: Minimize2,
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
];

export function getTone(id: string | undefined | null): Tone | null {
  if (!id) return null;
  return TONES.find((t) => t.id === id) ?? null;
}
