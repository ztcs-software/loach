// Coverage for slash-command recency — the pure half of D5.
//
// The ordering function has two contracts the palette depends on and that
// are easy to break by accident:
//   - hoisted rows form ONE contiguous block at the top, or the palette's
//     group headers repeat mid-list;
//   - sub-command rows never hoist, or typing `/list ` would drag every
//     sub-entry under a "Recent" header.

import { describe, it, expect } from "vitest";
import {
  RECENT_COMMANDS_MAX,
  RECENT_GROUP,
  orderByRecency,
  parseRecentCommands,
  pushRecentCommand,
} from "./recency";
import type { PaletteEntry } from "./parser";

/** Minimal palette entry — only `cmd.name`, `cmd.group` and `sub` matter. */
const entry = (name: string, group: string, sub: string | null = null): PaletteEntry => ({
  cmd: { name, description: `${name} desc`, group },
  sub,
  display: sub ? `/${name} ${sub}` : `/${name}`,
  insertText: `/${name}`,
  description: `${name} desc`,
});

const names = (entries: PaletteEntry[]) => entries.map((e) => e.cmd.name);

describe("parseRecentCommands", () => {
  it("round-trips a pushed list", () => {
    expect(parseRecentCommands(pushRecentCommand("", "new"))).toEqual(["new"]);
  });

  it("survives garbage instead of throwing", () => {
    expect(parseRecentCommands("not json")).toEqual([]);
    expect(parseRecentCommands('{"a":1}')).toEqual([]);
    expect(parseRecentCommands('[1,null,"new",""]')).toEqual(["new"]);
    expect(parseRecentCommands("")).toEqual([]);
  });
});

describe("pushRecentCommand", () => {
  it("moves a repeat to the head without duplicating it", () => {
    let s = "";
    for (const n of ["new", "model", "fork"]) s = pushRecentCommand(s, n);
    expect(parseRecentCommands(s)).toEqual(["fork", "model", "new"]);
    s = pushRecentCommand(s, "new");
    expect(parseRecentCommands(s)).toEqual(["new", "fork", "model"]);
  });

  it("returns the input unchanged when already at the head", () => {
    const s = pushRecentCommand("", "new");
    expect(pushRecentCommand(s, "new")).toBe(s);
  });

  it("caps the stored list", () => {
    let s = "";
    for (let i = 0; i < RECENT_COMMANDS_MAX + 4; i++) {
      s = pushRecentCommand(s, `cmd${i}`);
    }
    expect(parseRecentCommands(s)).toHaveLength(RECENT_COMMANDS_MAX);
  });
});

describe("orderByRecency", () => {
  const base = [
    entry("new", "Chat"),
    entry("fork", "Chat"),
    entry("model", "Model & persona"),
    entry("help", "App"),
  ];

  it("hoists recents in recency order, as one contiguous block", () => {
    const out = orderByRecency(base, ["model", "help"]);
    expect(names(out)).toEqual(["model", "help", "new", "fork"]);
    expect(out.slice(0, 2).every((e) => e.groupOverride === RECENT_GROUP)).toBe(true);
    // Untouched rows keep their registry group so their headers still render.
    expect(out.slice(2).every((e) => e.groupOverride === undefined)).toBe(true);
  });

  it("never duplicates a hoisted row", () => {
    const out = orderByRecency(base, ["fork"]);
    expect(out).toHaveLength(base.length);
    expect(names(out).filter((n) => n === "fork")).toHaveLength(1);
  });

  it("ignores names that aren't in the current result set", () => {
    expect(names(orderByRecency(base, ["nonexistent"]))).toEqual(names(base));
  });

  it("leaves sub-command entries where they are", () => {
    const subs = [
      entry("list", "Listings", "models"),
      entry("list", "Listings", "spaces"),
    ];
    const out = orderByRecency(subs, ["list"]);
    expect(out).toEqual(subs);
    expect(out.every((e) => e.groupOverride === undefined)).toBe(true);
  });

  it("no-ops on an empty history or a single row", () => {
    expect(orderByRecency(base, [])).toBe(base);
    const one = [entry("new", "Chat")];
    expect(orderByRecency(one, ["new"])).toBe(one);
  });
});
