import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMAGE_SCALING,
  describeImageScaling,
  parseImageScaling,
  resolveImageScaling,
  scaledSize,
} from "./imageScaling";
import type { ImageScaling } from "@/types";

const px = (n: number, enabled = true): ImageScaling => ({ enabled, mode: "px", px: n, percent: 50 });
const pct = (n: number): ImageScaling => ({ enabled: true, mode: "percent", px: 1024, percent: n });

describe("parseImageScaling", () => {
  it("reads what the controls write", () => {
    expect(parseImageScaling(JSON.stringify(pct(30)))).toEqual(pct(30));
  });

  it("treats unset or unreadable as inherit", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "not json",
      "null",
      JSON.stringify({ ...px(1024), mode: "zoom" }),
      JSON.stringify(px(32)),
      JSON.stringify(px(10_000)),
      JSON.stringify(pct(0)),
      JSON.stringify(pct(120)),
      JSON.stringify({ ...px(1024), px: 512.5 }),
      JSON.stringify({ enabled: "yes", mode: "px", px: 1024, percent: 50 }),
    ]) {
      expect(parseImageScaling(bad), String(bad)).toBeNull();
    }
  });
});

describe("resolveImageScaling", () => {
  it("takes the first level that sets it", () => {
    const chat = JSON.stringify(px(512));
    const space = JSON.stringify(pct(40));
    const app = JSON.stringify(px(2048, false));
    expect(resolveImageScaling(chat, space, app)).toEqual(px(512));
    expect(resolveImageScaling(null, space, app)).toEqual(pct(40));
    expect(resolveImageScaling(null, null, app)).toEqual(px(2048, false));
    // A broken level is skipped, not obeyed.
    expect(resolveImageScaling("garbage", null, app)).toEqual(px(2048, false));
  });

  it("falls back to 1024 px when nothing is set", () => {
    expect(resolveImageScaling(null, undefined, "")).toEqual(DEFAULT_IMAGE_SCALING);
    expect(DEFAULT_IMAGE_SCALING).toEqual(px(1024));
  });
});

describe("scaledSize", () => {
  it("caps the longest side in px mode, keeping the aspect ratio", () => {
    expect(scaledSize(6000, 4000, px(1024))).toEqual({ width: 1024, height: 683 });
    expect(scaledSize(3000, 6000, px(1024))).toEqual({ width: 512, height: 1024 });
  });

  it("shrinks both sides in percent mode", () => {
    expect(scaledSize(6000, 4000, pct(25))).toEqual({ width: 1500, height: 1000 });
  });

  it("never enlarges, and leaves everything alone when off", () => {
    expect(scaledSize(800, 600, px(1024))).toEqual({ width: 800, height: 600 });
    expect(scaledSize(800, 600, pct(100))).toEqual({ width: 800, height: 600 });
    expect(scaledSize(6000, 4000, px(1024, false))).toEqual({ width: 6000, height: 4000 });
  });

  it("keeps at least one pixel", () => {
    expect(scaledSize(10_000, 3, px(64))).toEqual({ width: 64, height: 1 });
  });
});

describe("describeImageScaling", () => {
  it("says what each setting does", () => {
    expect(describeImageScaling(px(1024))).toBe("longest side up to 1024 px");
    expect(describeImageScaling(pct(50))).toBe("50% of the original size");
    expect(describeImageScaling(px(1024, false))).toBe("original size");
  });
});
