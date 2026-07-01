import { describe, expect, it } from "vitest";
import { parseConfirm, parseSelection, parseText } from "../src/prompt.js";

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

describe("parseSelection", () => {
  const values = ["a", "b", "c"];
  const defaults = [true, false, true];

  it("empty input keeps the defaults (in value order)", () => {
    expect(parseSelection("", values, defaults)).toEqual(["a", "c"]);
    expect(parseSelection("   ", values, defaults)).toEqual(["a", "c"]);
  });

  it("'all' selects every value; 'none' selects nothing (case-insensitive)", () => {
    expect(parseSelection("all", values, defaults)).toEqual(["a", "b", "c"]);
    expect(parseSelection("ALL", values, defaults)).toEqual(["a", "b", "c"]);
    expect(parseSelection("none", values, defaults)).toEqual([]);
    expect(parseSelection("None", values, defaults)).toEqual([]);
  });

  it("a comma/space list of 1-based indices selects those values, in value order", () => {
    expect(parseSelection("1,3", values, defaults)).toEqual(["a", "c"]);
    expect(parseSelection("3 1", values, defaults)).toEqual(["a", "c"]);
    expect(parseSelection("2", values, defaults)).toEqual(["b"]);
  });

  it("out-of-range and non-numeric tokens are ignored; duplicates collapse", () => {
    expect(parseSelection("0,4,2,2,x", values, defaults)).toEqual(["b"]);
    expect(parseSelection("99", values, defaults)).toEqual([]);
  });
});
