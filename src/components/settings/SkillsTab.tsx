import { useEffect, useState } from "react";
import { AlertTriangle, FolderOpen, Loader2, Plus, Puzzle, RefreshCw, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { importSkill, openSkillsFolder } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSkillStore } from "@/stores/skillStore";
import { useToastStore } from "@/stores/toastStore";
import { SectionTitle } from "./shared";

function toastError(title: string, e: unknown) {
  useToastStore.getState().push({
    kind: "error",
    title,
    body: e instanceof Error ? e.message : String(e),
  });
}

/**
 * Settings → Skills: Agent Skills (agentskills.io) — folders with a
 * `SKILL.md` that teach the model a kind of task. The switches here decide
 * whether models are offered them at all, whether their scripts may run
 * (each run still asks), and which installed skills are offered.
 */
export function SkillsTab() {
  const enabled = useSettingsStore((s) => s.skills_enabled);
  const scripts = useSettingsStore((s) => s.skill_scripts_enabled);
  const update = useSettingsStore((s) => s.update);
  const catalog = useSkillStore((s) => s.catalog);
  const loadCatalog = useSkillStore((s) => s.loadCatalog);
  const setEnabled = useSkillStore((s) => s.setEnabled);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);

  const reload = async () => {
    setLoading(true);
    try {
      await loadCatalog();
    } catch (e) {
      toastError("Couldn't read the skills folders", e);
    } finally {
      setLoading(false);
    }
  };

  // Read the folders each time the tab opens: skills are added and removed
  // outside Loach, in a file manager or by another agent.
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doImport = async () => {
    setImporting(true);
    try {
      const name = await importSkill();
      if (name === null) return;
      await loadCatalog();
      useToastStore.getState().push({ kind: "info", title: "Skill imported", body: name });
    } catch (e) {
      toastError("Couldn't import the skill", e);
    } finally {
      setImporting(false);
    }
  };

  const toggle = async (name: string, next: boolean) => {
    try {
      await setEnabled(name, next);
    } catch (e) {
      toastError(`Couldn't ${next ? "enable" : "disable"} ${name}`, e);
    }
  };

  return (
    <>
      <SectionTitle>Skills</SectionTitle>
      <p className="text-[13px] text-foreground/55">
        Skills are folders with a <span className="font-mono">SKILL.md</span> that teach the model
        a kind of task — instructions, plus reference files and scripts it can use. They follow the
        open Agent Skills format, so skills made for other agents work here too.
      </p>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Label className="flex items-center gap-1.5">
            <Puzzle className="h-3.5 w-3.5 text-foreground/60" />
            Use skills
          </Label>
          <p className="mt-1 text-[11px] text-foreground/50">
            The model sees the name and description of every enabled skill, and loads one's
            instructions when your request matches it; <span className="font-mono">/skill</span>{" "}
            loads one yourself. A loaded skill stays on for the rest of the chat — remove its chip
            above the message box to drop it. Each enabled skill costs a few dozen tokens on every
            message, so switch off the ones you don't use. Not in Private Chat.
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(next) => void update("skills_enabled", next)}
          className="shrink-0"
          aria-label={enabled ? "Stop using skills" : "Use skills"}
        />
      </div>

      <div className="ml-5 flex items-start justify-between gap-4 border-l border-foreground/10 pl-3">
        <div className="min-w-0">
          <Label className="flex items-center gap-1.5">
            <Terminal className="h-3.5 w-3.5 text-foreground/60" />
            Let skills run scripts
          </Label>
          <p className="mt-1 text-[11px] text-foreground/50">
            Lets the model run the <span className="font-mono">.py</span>,{" "}
            <span className="font-mono">.sh</span>, <span className="font-mono">.js</span> and{" "}
            <span className="font-mono">.ps1</span> scripts a skill ships with, using the Python,
            bash, Node.js or PowerShell installed on this computer. Every run asks you first and
            shows the exact command. A script runs as you, with your access to every file — not
            only the chat's folder — so allow runs only from skills you trust. It runs in the
            chat's workspace folder if it has one, otherwise in the skill's folder, for up to 5
            minutes; Stop ends it.
          </p>
        </div>
        <Switch
          checked={scripts}
          onCheckedChange={(next) => void update("skill_scripts_enabled", next)}
          className="shrink-0"
          aria-label={scripts ? "Stop letting skills run scripts" : "Let skills run scripts"}
        />
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label>Installed skills</Label>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 rounded-lg"
              disabled={importing}
              onClick={() => void doImport()}
            >
              {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Import folder…
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5 rounded-lg text-foreground/65"
              onClick={() => void openSkillsFolder().catch((e) => toastError("Couldn't open the skills folder", e))}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              Open folder
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5 rounded-lg text-foreground/65"
              disabled={loading}
              onClick={() => void reload()}
              aria-label="Read the skills folders again"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              Refresh
            </Button>
          </div>
        </div>
        <p className="text-[11px] text-foreground/50">
          Read from Loach's skills folder and from <span className="font-mono">~/.agents/skills</span>,
          the folder other agents share. When both have a skill of the same name, Loach's is used.
        </p>

        {catalog && catalog.skills.length === 0 && catalog.problems.length === 0 && (
          <div className="rounded-xl border border-dashed border-foreground/15 px-4 py-6 text-center text-xs text-foreground/50">
            No skills installed yet. Import a skill's folder, or put one in the skills folder.
          </div>
        )}

        {catalog && catalog.skills.length > 0 && (
          <ul className="divide-y divide-foreground/10 rounded-xl border border-foreground/10">
            {catalog.skills.map((skill) => (
              <li key={skill.name} className="flex items-start justify-between gap-4 px-3 py-2.5">
                <div className={cn("min-w-0", !skill.enabled && "opacity-60")}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-xs font-medium text-foreground/85">{skill.name}</span>
                    <span className="rounded bg-foreground/[0.06] px-1.5 py-px text-[10px] text-foreground/55">
                      {skill.source === "loach" ? "Loach" : "~/.agents"}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-foreground/55">{skill.description}</p>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-foreground/40" title={skill.path}>
                    {skill.path}
                  </p>
                  {skill.warnings.map((w) => (
                    <p key={w} className="mt-0.5 flex items-start gap-1 text-[11px] text-amber-700 dark:text-amber-300">
                      <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                      {w}
                    </p>
                  ))}
                </div>
                <Switch
                  checked={skill.enabled}
                  onCheckedChange={(next) => void toggle(skill.name, next)}
                  className="mt-0.5 shrink-0"
                  aria-label={skill.enabled ? `Disable ${skill.name}` : `Enable ${skill.name}`}
                />
              </li>
            ))}
          </ul>
        )}

        {catalog && catalog.problems.length > 0 && (
          <div className="space-y-1.5 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-amber-800 dark:text-amber-200">
              <AlertTriangle className="h-3.5 w-3.5" />
              Not loaded
            </div>
            {catalog.problems.map((p) => (
              <div key={p.path + p.message} className="text-[11px]">
                <div className="font-mono text-foreground/60 [overflow-wrap:anywhere]">{p.path}</div>
                <div className="text-foreground/70">{p.message}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
