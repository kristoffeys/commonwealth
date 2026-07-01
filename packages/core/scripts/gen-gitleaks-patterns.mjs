// Dev generator: converts the vendored gitleaks ruleset (scripts/gitleaks.toml, MIT)
// into a filtered, JS-compatible, false-positive-safe pattern table emitted to
//   packages/core/src/secrets-gitleaks.generated.ts
//
// Run: node packages/core/scripts/gen-gitleaks-patterns.mjs
//
// Filtering (see the task spec / ADR-0010): we keep our zero-false-positive property,
// so a rule is SKIPPED when any of these hold:
//   - its regex fails to compile as a JS RegExp (Go RE2 features JS lacks: inline (?i)
//     mid-pattern, (?-i:...), etc.);
//   - its id contains "generic" (gitleaks generic rules lean on entropy — too broad);
//   - once (?i)/anchors are stripped it has no fixed literal run of >= 3 chars (i.e. it
//     is basically char-classes/quantifiers — too broad);
//   - it matches ANY string in the embedded benign corpus below (zero-FP gate).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOML_PATH = join(__dirname, "gitleaks.toml");
const OUT_PATH = join(__dirname, "..", "src", "secrets-gitleaks.generated.ts");

/**
 * Embedded benign corpus. NONE of these may match a kept pattern. Mirrors and extends
 * the false-positive guards in test/secrets.test.ts so the generator and the runtime
 * tests agree on what "clean" means.
 */
const BENIGN_CORPUS = [
  // A paragraph of ordinary prose.
  "The quarterly planning meeting covered roadmap priorities, hiring, and the budget " +
    "for the next two sprints. Nothing here should ever look like a credential to a scanner.",
  "the password is rotated monthly",
  "the password is stored securely",
  "tokenize the input before parsing",
  "we need to secret away some budget",
  "The access token flow uses PKCE for public clients.",
  // A 40-char git SHA.
  "commit 9f3d2a1b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f",
  "9f3d2a1b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f",
  // A UUID.
  "id 550e8400-e29b-41d4-a716-446655440000",
  "550e8400-e29b-41d4-a716-446655440000",
  // A base64 PNG data URI (~200 chars).
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA" +
    "DUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" +
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  // Common identifiers.
  "secretary = jane_doe_smith_here",
  "author = somereallylongname",
  "background = navy",
  "background = darkslategray_value1",
  "monkey = businesslogic123",
  "access token flow uses PKCE",
  "AC power adapter model number 12v",
  // A semver.
  "version 1.2.3-rc.4+build.567",
  "1.2.3",
  // An ISO timestamp.
  "2026-07-01T12:34:56.789Z",
  // A hex color.
  "#1a2b3c",
  "color: #ff8800;",
  // A file path.
  "src/packages/core/src/secrets-gitleaks.generated.ts",
  "/usr/local/lib/node_modules/typescript/bin/tsc",
  // A URL without creds.
  "https://example.com/path/to/resource?query=value&page=2",
  "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml",
];

/**
 * Parse the vendored TOML for the fields we need. We only care about [[rules]] blocks
 * and, within each, `id = "..."` and `regex = '''...'''` (triple-single-quoted, may span
 * lines). Dependency-free on purpose: no TOML lib enters the dependency tree.
 * @param {string} toml
 * @returns {Array<{ id: string; regex: string }>}
 */
function parseRules(toml) {
  /** @type {Array<{ id: string; regex: string }>} */
  const rules = [];
  // Split into [[rules]] blocks. The first chunk (before any [[rules]]) is the header
  // + [allowlist] and is discarded.
  const chunks = toml.split(/^\[\[rules\]\]$/m).slice(1);
  for (const chunk of chunks) {
    const idMatch = /^\s*id\s*=\s*"([^"]+)"/m.exec(chunk);
    // Triple-single-quoted string; non-greedy up to the closing ''' .
    const reMatch = /^\s*regex\s*=\s*'''([\s\S]*?)'''/m.exec(chunk);
    if (!idMatch || !reMatch) continue;
    rules.push({ id: idMatch[1], regex: reMatch[1] });
  }
  return rules;
}

/**
 * Convert a gitleaks (Go RE2) regex string to a JS regex body + flags. Strips a single
 * leading (?i) inline flag (and records that we need the "i" flag), and rewrites Go
 * named-group syntax (?P<name>) to JS (?<name>). Anything else is left as-is so that
 * JS-incompatible constructs (mid-pattern (?i), (?-i:...)) fail compilation and get
 * skipped by the caller.
 * @param {string} raw
 * @returns {{ body: string; caseInsensitive: boolean }}
 */
function toJsRegex(raw) {
  let body = raw;
  let caseInsensitive = false;
  if (body.startsWith("(?i)")) {
    caseInsensitive = true;
    body = body.slice(4);
  }
  // Go named groups (?P<name>...) -> JS (?<name>...). Safe, purely syntactic.
  body = body.replace(/\(\?P</g, "(?<");
  // Go POSIX character classes (e.g. [[:alnum:]]) are literal char-sets in JS; expand the
  // `[:name:]` token in place so the surrounding brackets still form a valid JS class.
  const POSIX = {
    "[:alnum:]": "A-Za-z0-9",
    "[:alpha:]": "A-Za-z",
    "[:digit:]": "0-9",
    "[:xdigit:]": "0-9A-Fa-f",
    "[:upper:]": "A-Z",
    "[:lower:]": "a-z",
    "[:space:]": "\\s",
    "[:word:]": "\\w",
    "[:punct:]": "!-/:-@\\[-`{-~",
    "[:blank:]": " \\t",
  };
  body = body.replace(/\[:[a-z]+:\]/g, (tok) => POSIX[tok] ?? tok);
  return { body, caseInsensitive };
}

/**
 * Does the pattern contain a fixed literal run of >= 3 consecutive ordinary characters?
 * We strip a leading (?i), anchors (^ $ \b \B \A \z), and then walk the source counting
 * runs of literal chars, resetting the run at any regex metacharacter or escape. This is
 * a conservative heuristic — its only job is to reject patterns that are essentially
 * char-classes/quantifiers with no anchoring literal (too broad for a zero-FP scanner).
 * @param {string} raw
 * @returns {boolean}
 */
function hasLiteralRun(raw) {
  let s = raw;
  if (s.startsWith("(?i)")) s = s.slice(4);
  // Drop word/string boundaries and anchors so they don't count as (or break) literals.
  s = s.replace(/\\[bBAzZ]/g, "").replace(/[\^$]/g, "");
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      // An escape consumes the next char and never counts as a literal run member.
      i++;
      run = 0;
      continue;
    }
    // Regex metacharacters break a literal run.
    if ("[](){}.*+?|".includes(c)) {
      run = 0;
      continue;
    }
    // Ordinary literal character.
    run++;
    if (run >= 3) return true;
  }
  return false;
}

/**
 * Compile a converted pattern to a global RegExp, returning null if it throws.
 * @param {string} body
 * @param {boolean} caseInsensitive
 * @returns {RegExp | null}
 */
function tryCompile(body, caseInsensitive) {
  // Reject scoped/mid-pattern inline flag groups — (?i), (?i:…), (?-i:…), (?ims:…). These
  // are ES2025 regex modifiers that only newer engines accept (Node 24), but Commons
  // targets Node >= 22, where they throw at RegExp construction. `new RegExp` on the
  // GENERATING host (which may be Node 24) would NOT catch them, so filter textually.
  // (Non-capturing (?:…), lookaround (?=…)/(?!…)/(?<=…), and named (?<name>…) are fine.)
  if (/\(\?[-a-z]*[a-z][-a-z]*[:)]/.test(body)) return null;
  try {
    return new RegExp(body, caseInsensitive ? "gi" : "g");
  } catch {
    return null;
  }
}

/**
 * @param {RegExp} re
 * @returns {boolean} true if `re` matches any benign-corpus string.
 */
function matchesBenign(re) {
  for (const text of BENIGN_CORPUS) {
    re.lastIndex = 0;
    if (re.test(text)) return true;
  }
  return false;
}

async function main() {
  const toml = readFileSync(TOML_PATH, "utf8");
  const rules = parseRules(toml);

  /** @type {Array<{ kind: string; body: string; caseInsensitive: boolean }>} */
  const kept = [];
  const skipped = { total: 0, generic: 0, noLiteral: 0, compileError: 0, benignFp: 0 };
  /** @type {Array<{ id: string; reason: string }>} */
  const skipDetail = [];

  for (const rule of rules) {
    const skip = (reason, key) => {
      skipped.total++;
      skipped[key]++;
      skipDetail.push({ id: rule.id, reason });
    };

    if (/generic/i.test(rule.id)) {
      skip("id contains 'generic'", "generic");
      continue;
    }
    if (!hasLiteralRun(rule.regex)) {
      skip("no fixed literal run >= 3", "noLiteral");
      continue;
    }
    const { body, caseInsensitive } = toJsRegex(rule.regex);
    const re = tryCompile(body, caseInsensitive);
    if (re === null) {
      skip("JS-incompatible (compile threw)", "compileError");
      continue;
    }
    if (matchesBenign(re)) {
      skip("matched benign corpus", "benignFp");
      continue;
    }
    kept.push({ kind: `gitleaks:${rule.id}`, body, caseInsensitive });
  }

  // Emit deterministically (source order is already stable/alphabetical from gitleaks).
  const header = `/**
 * GENERATED — do not edit. Source: gitleaks (MIT). Regenerate: node
 * packages/core/scripts/gen-gitleaks-patterns.mjs
 *
 * Filtered, JS-compatible, false-positive-safe subset of the gitleaks ruleset. Each
 * \`re\` is global-flagged (and case-insensitive when the source had a leading \`(?i)\`).
 * Kept ${kept.length} of ${rules.length} rules; the rest were skipped as generic,
 * too broad, JS-incompatible, or benign-corpus false positives.
 */

/** A gitleaks-derived credential pattern. \`kind\` is \`"gitleaks:" + rule.id\`. */
export const GITLEAKS_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
`;

  const bodyLines = kept
    .map((k) => {
      // Emit the source as a RegExp literal is unsafe (slashes/newlines); use the
      // RegExp constructor with a JSON-encoded string so any character survives.
      const flags = k.caseInsensitive ? "gi" : "g";
      return `  { kind: ${JSON.stringify(k.kind)}, re: new RegExp(${JSON.stringify(
        k.body,
      )}, ${JSON.stringify(flags)}) },`;
    })
    .join("\n");

  const raw = `${header}${bodyLines}\n];\n`;
  // Format with the repo's Prettier config so the committed file is style-clean and
  // survives `pnpm lint` / `prettier --check` without a manual pass.
  const prettierConfig = (await prettier.resolveConfig(OUT_PATH)) ?? {};
  const out = await prettier.format(raw, { ...prettierConfig, parser: "typescript" });
  writeFileSync(OUT_PATH, out, "utf8");

  // Report.
  console.log(`gitleaks rules parsed:   ${rules.length}`);
  console.log(`  kept:                  ${kept.length}`);
  console.log(`  skipped:               ${skipped.total}`);
  console.log(`    generic id:          ${skipped.generic}`);
  console.log(`    no literal run:      ${skipped.noLiteral}`);
  console.log(`    JS-incompatible:     ${skipped.compileError}`);
  console.log(`    benign-corpus FP:    ${skipped.benignFp}`);
  const fps = skipDetail.filter((d) => d.reason === "matched benign corpus");
  if (fps.length > 0) {
    console.log(`  benign FP rules excluded: ${fps.map((f) => f.id).join(", ")}`);
  }
  console.log(`wrote ${OUT_PATH}`);
}

await main();
