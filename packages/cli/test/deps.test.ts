import { describe, expect, it } from "vitest";
import { codexListJsonHasEntry } from "../src/deps.js";

describe("codexListJsonHasEntry", () => {
  it("finds installed plugins and configured marketplaces", () => {
    expect(
      codexListJsonHasEntry(
        JSON.stringify({ installed: [{ pluginId: "commonwealth@commonwealth" }] }),
        "commonwealth",
      ),
    ).toBe(true);
    expect(
      codexListJsonHasEntry(
        JSON.stringify({ marketplaces: [{ name: "commonwealth" }] }),
        "commonwealth",
      ),
    ).toBe(true);
  });

  it("does not confuse an available plugin with an installed plugin", () => {
    expect(
      codexListJsonHasEntry(
        JSON.stringify({
          installed: [],
          available: [{ pluginId: "commonwealth@commonwealth", name: "commonwealth" }],
        }),
        "commonwealth",
      ),
    ).toBe(false);
  });
});
