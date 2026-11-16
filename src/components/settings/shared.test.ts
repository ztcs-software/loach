// The base-URL check behind Settings → Providers (F6-02). A URL saved as
// typed — a trailing space, no scheme — broke every request with reqwest's
// bare "builder error".

import { describe, expect, it } from "vitest";
import { baseUrlProblem } from "./shared";

describe("baseUrlProblem", () => {
  it("accepts http and https URLs", () => {
    for (const url of ["http://localhost:11434", "https://api.openai.com/v1", "http://192.168.1.20:8000/v1/"]) {
      expect(baseUrlProblem(url)).toBeNull();
    }
  });

  it("refuses a URL without a scheme, or with another one", () => {
    expect(baseUrlProblem("localhost:11434")).toMatch(/http/);
    expect(baseUrlProblem("ftp://example.com")).toMatch(/http/);
    expect(baseUrlProblem("")).toMatch(/http/);
  });

  it("refuses a space inside the host", () => {
    expect(baseUrlProblem("http://local host:11434")).not.toBeNull();
  });
});
