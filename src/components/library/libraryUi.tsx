import {
  AlertTriangle,
  Database,
  File,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  Globe,
  Loader2,
  NotebookPen,
  Search,
  Sparkles,
} from "lucide-react";
import { formatTokens } from "@/lib/contextUsage";
import { cn } from "@/lib/utils";
import { useLibraryStore } from "@/stores/libraryStore";
import { useUIStore } from "@/stores/uiStore";
import type { LibraryItemMeta } from "@/types";

/** The four Library sections, in tab order. */
export type LibraryTab = "datasets" | "texts" | "files" | "links";

export const TAB_LABELS: Record<LibraryTab, string> = {
  datasets: "Datasets",
  texts: "Texts",
  files: "Files",
  links: "Links",
};

/** Section an item is listed under. */
export function tabOf(item: LibraryItemMeta): Exclude<LibraryTab, "datasets"> {
  return item.kind === "text" ? "texts" : item.kind === "link" ? "links" : "files";
}

/** Rough token cost of an item's text (images cost nothing here — they go
 *  to vision models as images). */
export function itemTokens(item: LibraryItemMeta): number {
  return item.media === "text" ? Math.ceil(item.chars / 4) : 0;
}

export function tokensLabel(tokens: number): string {
  return `~${formatTokens(tokens)} tokens`;
}

const EXT_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
  "text/markdown": "Markdown",
  "text/plain": "Text",
  "text/html": "Web page",
  "text/csv": "CSV",
  "application/json": "JSON",
};

/** Short human file type: "PDF", "Word", "PNG", or the file extension. */
export function typeLabel(item: LibraryItemMeta): string {
  if (item.kind === "text") return "Text";
  if (item.kind === "link") return "Web page";
  if (EXT_LABELS[item.mime]) return EXT_LABELS[item.mime];
  if (item.media === "image") return (item.mime.split("/")[1] ?? "Image").toUpperCase();
  const ext = item.title.includes(".") ? item.title.split(".").pop() : null;
  return ext ? ext.toUpperCase() : "File";
}

export function domainOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const CODE_EXT = /\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|cs|rb|php|swift|kt|sh|sql|toml|ya?ml|json|xml|html|css)$/i;

/** Accent per kind — a soft tinted tile so the four sections read apart at a
 *  glance without shouting. */
const TONES = {
  dataset: "bg-violet-500/[0.12] text-violet-600 dark:text-violet-300",
  text: "bg-amber-500/[0.12] text-amber-700 dark:text-amber-300",
  file: "bg-sky-500/[0.12] text-sky-700 dark:text-sky-300",
  image: "bg-pink-500/[0.12] text-pink-700 dark:text-pink-300",
  link: "bg-emerald-500/[0.12] text-emerald-700 dark:text-emerald-300",
} as const;

export function ItemIcon({
  item,
  size = "md",
}: {
  item: LibraryItemMeta;
  size?: "sm" | "md";
}) {
  let Icon = File;
  let tone: string = TONES.file;
  if (item.kind === "text") {
    Icon = NotebookPen;
    tone = TONES.text;
  } else if (item.kind === "link") {
    Icon = Globe;
    tone = TONES.link;
  } else if (item.media === "image") {
    Icon = FileImage;
    tone = TONES.image;
  } else if (item.mime === "text/csv" || /\.(csv|tsv|xlsx?)$/i.test(item.title)) {
    Icon = FileSpreadsheet;
  } else if (CODE_EXT.test(item.title)) {
    Icon = FileCode2;
  } else {
    Icon = FileText;
  }
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        size === "sm" ? "h-7 w-7 rounded-lg" : "h-9 w-9 rounded-xl",
        tone,
      )}
    >
      <Icon className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} />
    </span>
  );
}

export function DatasetIcon({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        size === "sm" ? "h-7 w-7 rounded-lg" : size === "lg" ? "h-11 w-11 rounded-2xl" : "h-9 w-9 rounded-xl",
        TONES.dataset,
      )}
    >
      <Database className={size === "sm" ? "h-3.5 w-3.5" : size === "lg" ? "h-5 w-5" : "h-4 w-4"} />
    </span>
  );
}

/** "3 texts · 2 files · 1 link" for a set of items. */
export function mixLabel(items: LibraryItemMeta[]): string {
  const counts = { text: 0, file: 0, link: 0 };
  for (const i of items) counts[i.kind] += 1;
  const parts: string[] = [];
  if (counts.text) parts.push(`${counts.text} text${counts.text === 1 ? "" : "s"}`);
  if (counts.file) parts.push(`${counts.file} file${counts.file === 1 ? "" : "s"}`);
  if (counts.link) parts.push(`${counts.link} link${counts.link === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "Empty";
}

/** Retrieval-index state of one item, as a small inline badge. Silent when
 *  there's nothing to say. */
export function IndexBadge({ item }: { item: LibraryItemMeta }) {
  const model = useLibraryStore((s) => s.indexStatus?.model ?? null);
  if (item.truncated) {
    return (
      <span
        className="rounded-full bg-amber-500/[0.12] px-1.5 py-px text-[10px] font-medium text-amber-700 dark:text-amber-300"
        title="Only the first part of this item was kept — it hit the 200,000-character limit."
      >
        Truncated
      </span>
    );
  }
  if (model && item.media === "text" && item.chunks > item.embedded) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10.5px] text-foreground/45"
        title="Being indexed for search by meaning. It's already searchable by keyword."
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        Indexing
      </span>
    );
  }
  return null;
}

/** Where the retrieval index stands, as a pill that opens Settings → Library. */
export function IndexStatusPill() {
  const status = useLibraryStore((s) => s.indexStatus);
  const openSettingsTab = useUIStore((s) => s.openSettingsTab);
  let icon = <Search className="h-3.5 w-3.5" />;
  let label = "Keyword search";
  let title =
    "Large sources are searched by keyword. Set an embedding model in Settings → Library to also search by meaning.";
  let tone = "text-foreground/55";
  if (status?.model) {
    const model = status.model.split(":").slice(1).join(":");
    if (status.error) {
      icon = <AlertTriangle className="h-3.5 w-3.5" />;
      label = "Embedding paused";
      title = `${model}: ${status.error}`;
      tone = "text-amber-700 dark:text-amber-300";
    } else if (status.busy || status.embedded < status.total) {
      icon = <Loader2 className="h-3.5 w-3.5 animate-spin" />;
      label = `Indexing ${status.embedded.toLocaleString()} / ${status.total.toLocaleString()}`;
      title = `Embedding with ${model}. Sources stay searchable by keyword meanwhile.`;
    } else {
      icon = <Sparkles className="h-3.5 w-3.5" />;
      label = "Smart search";
      title = `Search by meaning and keyword, embedded with ${model}.`;
      tone = "text-foreground/65";
    }
  }
  return (
    <button
      type="button"
      onClick={() => openSettingsTab("library")}
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-foreground/10 bg-foreground/[0.03] px-3 py-1.5 text-xs transition-colors hover:bg-foreground/[0.07] hover:text-foreground",
        tone,
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/** A checkbox that only shows on hover / focus / when something is already
 *  selected, so browsing stays uncluttered. */
export function SelectBox({
  checked,
  visible,
  onToggle,
  label,
}: {
  checked: boolean;
  visible: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      aria-label={label}
      onClick={(e) => e.stopPropagation()}
      onChange={onToggle}
      className={cn(
        "h-4 w-4 shrink-0 cursor-pointer accent-[rgb(var(--primary-glow))] transition-opacity",
        checked || visible ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
      )}
    />
  );
}
