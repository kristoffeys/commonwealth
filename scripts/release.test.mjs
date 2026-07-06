import { describe, expect, it } from "vitest";
import { nextVersion } from "./release.mjs";

describe("nextVersion", () => {
  it("bumps patch/minor/major, zeroing lower components", () => {
    expect(nextVersion("0.1.2", "patch")).toBe("0.1.3");
    expect(nextVersion("0.1.2", "minor")).toBe("0.2.0");
    expect(nextVersion("0.1.2", "major")).toBe("1.0.0");
    expect(nextVersion("1.9.9", "minor")).toBe("1.10.0");
  });

  it("accepts an explicit forward version", () => {
    expect(nextVersion("0.1.2", "0.1.5")).toBe("0.1.5");
    expect(nextVersion("0.1.2", "1.0.0")).toBe("1.0.0");
  });

  it("rejects a non-forward explicit version (guards typos/downgrades)", () => {
    expect(() => nextVersion("0.1.2", "0.1.2")).toThrow(/not greater than/);
    expect(() => nextVersion("0.1.2", "0.1.1")).toThrow(/not greater than/);
    expect(() => nextVersion("2.0.0", "1.9.9")).toThrow(/not greater than/);
  });

  it("rejects a malformed version argument", () => {
    expect(() => nextVersion("0.1.2", "v1")).toThrow(/not a semver/);
    expect(() => nextVersion("0.1.2", "1.2")).toThrow(/not a semver/);
  });
});
