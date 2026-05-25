import type { CommandSpec } from "./types";

// Canonical list of slash commands. The dispatcher reads `name` to route to a
// handler in `./dispatch.ts`; the palette reads `description` / `usage` /
// `subcommands` to render hints; the `/help` dialog reads `group` to render
// scannable sections. Keep this list ordered the way it should appear in the
// palette — there's no separate sort layer.
export const COMMANDS: readonly CommandSpec[] = [
  // ----- chat session control -----
  {
    name: "new",
    description: "Start a new chat",
    group: "Chat",
  },
  {
    name: "clear",
    description: "Delete all messages in the current chat",
    group: "Chat",
  },
  {
    name: "rename",
    description: "Rename the current chat",
    usage: "<title>",
    group: "Chat",
  },
  {
    name: "pin",
    description: "Pin or unpin the current chat",
    group: "Chat",
  },
  {
    name: "archive",
    description: "Archive the current chat",
    group: "Chat",
  },
  {
    name: "delete",
    description: "Delete the current chat",
    group: "Chat",
  },
  {
    name: "regenerate",
    description: "Re-stream the last assistant reply",
    group: "Chat",
  },
  {
    name: "copy",
    description: "Copy the last (or Nth-latest) assistant reply",
    usage: "[N]",
    group: "Chat",
  },
  {
    name: "stats",
    description: "Show token / speed metrics for this chat",
    group: "Chat",
  },
  {
    name: "compact",
    description: "Summarise older messages to free context",
    group: "Chat",
  },
  {
    name: "private",
    description: "Open a Private Chat (no persistence)",
    group: "Chat",
  },

  // ----- model & persona -----
  {
    name: "model",
    description: "Switch model for this chat",
    usage: "<name>",
    group: "Model & persona",
  },
  {
    name: "persona",
    description: "Apply a persona to this chat",
    usage: "<name>",
    group: "Model & persona",
  },

  // ----- listings -----
  {
    name: "list",
    description: "List something",
    subcommands: [
      "models",
      "personas",
      "spaces",
      "snippets",
      "mcp",
      "providers",
      "memories",
    ],
    group: "Listings",
  },

  // ----- generation parameters -----
  {
    name: "temp",
    description: "Set sampling temperature",
    usage: "<0–2>",
    group: "Parameters",
  },
  {
    name: "top_p",
    description: "Set nucleus-sampling top_p",
    usage: "<0–1>",
    group: "Parameters",
  },
  {
    name: "top_k",
    description: "Set top_k",
    usage: "<int>",
    group: "Parameters",
  },
  {
    name: "min_p",
    description: "Set min_p",
    usage: "<0–1>",
    group: "Parameters",
  },
  {
    name: "max-tokens",
    description: "Set max output tokens",
    usage: "<int>",
    group: "Parameters",
  },
  {
    name: "num_ctx",
    description: "Set context window",
    usage: "<int>",
    group: "Parameters",
  },
  {
    name: "seed",
    description: "Set RNG seed (or 'random')",
    usage: "<int|random>",
    group: "Parameters",
  },
  {
    name: "parameters",
    description: "Reset generation parameters",
    subcommands: ["reset"],
    group: "Parameters",
  },

  // ----- per-chat instructions & snippets -----
  {
    name: "instructions",
    description: "Set or clear per-chat instructions",
    usage: "<text|clear>",
    subcommands: ["clear"],
    group: "Prompts",
  },
  {
    name: "snippet",
    description: "Expand a saved snippet into the composer",
    usage: "<name>",
    group: "Prompts",
  },

  // ----- memory & spaces -----
  {
    name: "remember",
    description: "Save a fact to the active space's memory",
    usage: "<fact>",
    group: "Memory & spaces",
  },
  {
    name: "forget",
    description: "Remove a memory by id or content match",
    usage: "<id|query>",
    group: "Memory & spaces",
  },
  {
    name: "space",
    description: "Switch the active space",
    usage: "<name>",
    group: "Memory & spaces",
  },

  // ----- tools & web -----
  {
    name: "tools",
    description: "List tools exposed by enabled MCP servers",
    group: "Tools & web",
  },
  {
    name: "web-fetch",
    description: "Toggle URL fetching for prompts",
    usage: "on|off",
    subcommands: ["on", "off"],
    group: "Tools & web",
  },
  {
    name: "fetch",
    description: "Fetch a URL and show its content",
    usage: "<url>",
    group: "Tools & web",
  },
  {
    name: "thinking",
    description: "Toggle the model's reasoning step (Ollama)",
    usage: "on|off",
    subcommands: ["on", "off"],
    group: "Tools & web",
  },

  // ----- app surfaces -----
  {
    name: "settings",
    description: "Open Settings",
    usage: "[tab]",
    group: "App",
  },
  {
    name: "help",
    description: "Show this command reference",
    group: "App",
  },
];
