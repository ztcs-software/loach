import type { CommandSpec } from "./types";

// Canonical list of slash commands. The dispatcher reads `name` to route to a
// handler in `./dispatch.ts`; the palette reads `description` / `usage` /
// `subcommands` to render hints. Keep this list ordered the way it should
// appear in the palette — there's no separate sort layer.
export const COMMANDS: readonly CommandSpec[] = [
  // ----- chat session control -----
  {
    name: "new",
    description: "Start a new chat",
  },
  {
    name: "clear",
    description: "Delete all messages in the current chat",
  },
  {
    name: "rename",
    description: "Rename the current chat",
    usage: "<title>",
  },
  {
    name: "pin",
    description: "Pin or unpin the current chat",
  },
  {
    name: "archive",
    description: "Archive the current chat",
  },
  {
    name: "delete",
    description: "Delete the current chat",
  },

  // ----- model & persona -----
  {
    name: "model",
    description: "Switch model for this chat",
    usage: "<name>",
  },
  {
    name: "persona",
    description: "Apply a persona to this chat",
    usage: "<name>",
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
  },

  // ----- generation parameters -----
  {
    name: "temp",
    description: "Set sampling temperature",
    usage: "<0–2>",
  },
  {
    name: "top_p",
    description: "Set nucleus-sampling top_p",
    usage: "<0–1>",
  },
  {
    name: "top_k",
    description: "Set top_k",
    usage: "<int>",
  },
  {
    name: "min_p",
    description: "Set min_p",
    usage: "<0–1>",
  },
  {
    name: "max-tokens",
    description: "Set max output tokens",
    usage: "<int>",
  },
  {
    name: "num_ctx",
    description: "Set context window",
    usage: "<int>",
  },
  {
    name: "seed",
    description: "Set RNG seed (or 'random')",
    usage: "<int|random>",
  },
  {
    name: "parameters",
    description: "Reset generation parameters",
    subcommands: ["reset"],
  },

  // ----- per-chat instructions & snippets -----
  {
    name: "instructions",
    description: "Set or clear per-chat instructions",
    usage: "<text|clear>",
    subcommands: ["clear"],
  },
  {
    name: "snippet",
    description: "Expand a saved snippet into the composer",
    usage: "<name>",
  },

  // ----- memory & spaces -----
  {
    name: "remember",
    description: "Save a fact to the active space's memory",
    usage: "<fact>",
  },
  {
    name: "forget",
    description: "Remove a memory by id or content match",
    usage: "<id|query>",
  },
  {
    name: "space",
    description: "Switch the active space",
    usage: "<name>",
  },

  // ----- tools & web -----
  {
    name: "tools",
    description: "List tools exposed by enabled MCP servers",
  },
  {
    name: "web-fetch",
    description: "Toggle URL fetching for prompts",
    usage: "on|off",
    subcommands: ["on", "off"],
  },
  {
    name: "fetch",
    description: "Fetch a URL and show its content",
    usage: "<url>",
  },
  {
    name: "thinking",
    description: "Toggle the model's reasoning step (Ollama)",
    usage: "on|off",
    subcommands: ["on", "off"],
  },
];
