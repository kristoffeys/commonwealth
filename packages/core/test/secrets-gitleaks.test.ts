import { describe, expect, it } from "vitest";
import { findSecrets, hasSecrets } from "../src/secrets.js";
import { GITLEAKS_PATTERNS } from "../src/secrets-gitleaks.generated.js";

describe("GITLEAKS_PATTERNS", () => {
  it("is non-empty and above a sane lower bound", () => {
    // The generator keeps ~200 rules; guard against a regression that empties the set.
    expect(GITLEAKS_PATTERNS.length).toBeGreaterThanOrEqual(40);
  });

  it("every entry's re is a global RegExp", () => {
    for (const { kind, re } of GITLEAKS_PATTERNS) {
      expect(re, `re for ${kind}`).toBeInstanceOf(RegExp);
      expect(re.global, `global flag for ${kind}`).toBe(true);
      expect(kind.startsWith("gitleaks:"), `kind namespace for ${kind}`).toBe(true);
    }
  });
});

describe("gitleaks merge: zero false positives over the benign corpus", () => {
  // Extends the corpus embedded in the generator (and secrets.test.ts). NONE may flag.
  const clean = [
    "The quarterly planning meeting covered roadmap priorities and hiring.",
    "the password is rotated monthly",
    "tokenize the input before parsing",
    "The access token flow uses PKCE for public clients.",
    "commit 9f3d2a1b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f",
    "id 550e8400-e29b-41d4-a716-446655440000",
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA" +
      "DUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "secretary = jane_doe_smith_here",
    "author = somereallylongname",
    "background = navy",
    "access token flow uses PKCE",
    "version 1.2.3-rc.4+build.567",
    "2026-07-01T12:34:56.789Z",
    "#1a2b3c",
    "src/packages/core/src/secrets-gitleaks.generated.ts",
    "https://example.com/path/to/resource?query=value&page=2",
    // Provider names in prose near an equals — the classic context-rule FP trap.
    "We use adafruit sensors; airtable = the spreadsheet database we chose.",
    "sentry = error monitoring, datadog = metrics, algolia = search",
    "Our okta identity provider integration works fine.",
    'etag = "33a64df551425fcc55e4d42a148795d9f25f89d4"',
    "transaction_id = 8f7d6e5c4b3a29180f7e6d5c4b3a2918",
  ];

  for (const text of clean) {
    it(`does NOT flag: ${text.slice(0, 48)}`, () => {
      expect(hasSecrets(text)).toBe(false);
      expect(findSecrets(text)).toHaveLength(0);
    });
  }
});

describe("gitleaks merge: catches secrets our hand-set misses", () => {
  // Each sample is shaped to a specific KEPT gitleaks rule. If a rule is dropped in a
  // future regen these assertions fail loudly rather than silently losing coverage.

  it("flags a GitLab PAT (glpat-)", () => {
    // regex: glpat-[\w-]{20}
    expect(hasSecrets("token: glpat-AbCdEf0123456789xyzW")).toBe(true);
    const found = findSecrets("token: glpat-AbCdEf0123456789xyzW");
    expect(found.some((f) => f.kind === "gitleaks:gitlab-pat")).toBe(true);
  });

  it("flags a 1Password service-account token (ops_eyJ...)", () => {
    // regex: ops_eyJ[a-zA-Z0-9+/]{250,}={0,3}
    const token = "ops_eyJ" + "a".repeat(260);
    expect(hasSecrets(token)).toBe(true);
    const found = findSecrets(token);
    expect(found.some((f) => f.kind === "gitleaks:1password-service-account-token")).toBe(true);
  });

  it("flags a GitLab pipeline trigger token (glptt-)", () => {
    // regex: glptt-[0-9a-f]{40}
    const token = "glptt-" + "0123456789abcdef0123456789abcdef01234567";
    expect(hasSecrets(token)).toBe(true);
    const found = findSecrets(token);
    expect(found.some((f) => f.kind === "gitleaks:gitlab-ptt")).toBe(true);
  });

  it("flags an Airtable PAT (POSIX [[:alnum:]] correctly expanded)", () => {
    // regex: pat[[:alnum:]]{14}\.[a-f0-9]{64} — the POSIX class must be expanded to
    // [A-Za-z0-9] at generation, else JS misreads it and the rule can never match.
    const token = "patABCDEFGH123456." + "a".repeat(64);
    expect(hasSecrets(token)).toBe(true);
    const found = findSecrets(token);
    expect(found.some((f) => f.kind === "gitleaks:airtable-personnal-access-token")).toBe(true);
  });
});
