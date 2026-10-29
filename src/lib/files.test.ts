// `decodeTextBytes`: how an attached text file's bytes become the text the
// model reads. `File.text()` read everything as UTF-8, so a UTF-16 file came
// through as NUL-ridden noise and a legacy Windows-1250 one (Polish Notepad's
// old default) lost every Polish letter to U+FFFD.

import { describe, it, expect } from "vitest";
import { decodeTextBytes } from "./files";

const PL = "Zażółć gęślą jaźń";

const utf8 = (s: string) => new TextEncoder().encode(s);
function utf16(s: string, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i * 2] = littleEndian ? c & 0xff : c >> 8;
    out[i * 2 + 1] = littleEndian ? c >> 8 : c & 0xff;
  }
  return out;
}
const withBom = (bom: number[], body: Uint8Array) => new Uint8Array([...bom, ...body]);

describe("decodeTextBytes", () => {
  it("reads plain UTF-8, with or without a byte-order mark", () => {
    expect(decodeTextBytes(utf8(PL), "en-US")).toBe(PL);
    expect(decodeTextBytes(withBom([0xef, 0xbb, 0xbf], utf8(PL)), "en-US")).toBe(PL);
  });

  it("reads UTF-16 by its byte-order mark", () => {
    expect(decodeTextBytes(withBom([0xff, 0xfe], utf16(PL, true)), "en-US")).toBe(PL);
    expect(decodeTextBytes(withBom([0xfe, 0xff], utf16(PL, false)), "en-US")).toBe(PL);
  });

  it("tells UTF-16 without a byte-order mark by its NUL bytes", () => {
    const text = `${PL}\nname,value\nalpha,1\n`;
    expect(decodeTextBytes(utf16(text, true), "en-US")).toBe(text);
    expect(decodeTextBytes(utf16(text, false), "en-US")).toBe(text);
  });

  it("falls back to the ANSI code page of the UI language", () => {
    // "Zażółć" saved by a Polish Windows as Windows-1250.
    const cp1250 = new Uint8Array([0x5a, 0x61, 0xbf, 0xf3, 0xb3, 0xe6]);
    expect(decodeTextBytes(cp1250, "pl-PL")).toBe("Zażółć");
    expect(decodeTextBytes(cp1250, "cs")).toBe("Zażółć");
    // "Café" from a Western European Windows, as Windows-1252.
    expect(decodeTextBytes(new Uint8Array([0x43, 0x61, 0x66, 0xe9]), "en-GB")).toBe("Café");
  });
});
