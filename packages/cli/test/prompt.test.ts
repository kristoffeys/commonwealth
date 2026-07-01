import { describe, expect, it } from "vitest";
import { parseConfirm, parseText } from "../src/prompt.js";

describe("parseConfirm", () => {
  it("empty input returns the default (both directions)", () => {
    expect(parseConfirm("", true)).toBe(true);
    expect(parseConfirm("", false)).toBe(false);
    expect(parseConfirm("   ", true)).toBe(true);
    expect(parseConfirm("   ", false)).toBe(false);
  });

  it("parses y/yes as true, case-insensitively and trimmed", () => {
    for (const s of ["y", "Y", "yes", "YES", " Yes ", "yEs"]) {
      expect(parseConfirm(s, false)).toBe(true);
    }
  });

  it("parses n/no as false, case-insensitively and trimmed", () => {
    for (const s of ["n", "N", "no", "NO", " No ", "nO"]) {
      expect(parseConfirm(s, true)).toBe(false);
    }
  });

  it("unrecognized input falls back to the default", () => {
    expect(parseConfirm("maybe", true)).toBe(true);
    expect(parseConfirm("maybe", false)).toBe(false);
    expect(parseConfirm("yep", false)).toBe(false);
  });
});

describe("parseText", () => {
  it("empty (or whitespace-only) input returns the default", () => {
    expect(parseText("", "def")).toBe("def");
    expect(parseText("   ", "def")).toBe("def");
  });

  it("non-empty input is trimmed and returned", () => {
    expect(parseText("hello", "def")).toBe("hello");
    expect(parseText("  spaced  ", "def")).toBe("spaced");
  });
});
