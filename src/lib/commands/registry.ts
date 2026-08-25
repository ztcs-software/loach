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
    name: "fork",
    description: "Fork this chat into a new copy",
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
    name: "export",
    description: "Export this chat's context",
    group: "Chat",
  },
  {
    name: "stats",
    description: "Show token / speed metrics for this chat",
    group: "Chat",
  },
  {
    name: "compact",
    description: "Summarize older messages to free context",
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
    description: "List models, personas, spaces, snippets, MCP servers…",
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
