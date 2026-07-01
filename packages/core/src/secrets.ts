/**
 * Secret scanner (issue #16). A shared, synced brain must never carry credentials, so
 * we detect and redact common, low-false-positive secrets. Used to block secrets at
 * capture (curate) and to scrub hand-edited notes at pre-commit (sync) as defense in
 * depth. Detection is intentionally conservative: patterns are tuned to real credential
 * shapes so ordinary prose (e.g. "the password is rotated monthly") does not match.
 */

import { GITLEAKS_PATTERNS } from "./secrets-gitleaks.generated.js";

/** A single detected secret. Never carries the raw value — only a masked preview. */
export interface SecretMatch {
  /** Which pattern matched (e.g. "aws-access-key-id", "github-token"). */
  kind: string;
  /** Zero-based index of the match start within the scanned text. */
  index: number;
  /** Length in characters of the matched substring. */
  length: number;
  /** The match with its middle masked (first4 + "..." + last2); never the full secret. */
  preview: string;
}

/**
 * Credential patterns, ordered most-specific first so a value that could match both a
 * specific provider and the generic assignment is attributed to the specific provider.
 * Each `re` MUST be global (`g`) so {@link findSecrets} can iterate all matches.
 */
export const SECRET_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: "aws-access-key-id", re: /AKIA[0-9A-Z]{16}/g },
  { kind: "github-token", re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g },
  { kind: "github-pat", re: /github_pat_[A-Za-z0-9_]{20,}/g },
  // Anthropic base64url bodies include "_", and modern keys are sk-ant-api03-… .
  { kind: "anthropic-api-key", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  // Modern OpenAI keys are prefixed (sk-proj-/sk-svcacct-/sk-admin-) with hyphens in the
  // body; keep the legacy pure-alnum form too. Ordered after anthropic so sk-ant- wins.
  {
    kind: "openai-api-key",
    re: /sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}/g,
  },
  { kind: "google-api-key", re: /AIza[0-9A-Za-z_-]{35}/g },
  { kind: "google-oauth-token", re: /ya29\.[0-9A-Za-z_-]{20,}/g },
  { kind: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  {
    kind: "slack-webhook",
    re: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9_]+/g,
  },
  // Stripe (sk_live_/pk_live_/rk_test_…), SendGrid, npm, Twilio SID/key — distinctive
  // prefixes, low false-positive. Inspired by the SecretFinder pattern set.
  { kind: "stripe-key", re: /(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}/g },
  { kind: "sendgrid-key", re: /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  { kind: "npm-token", re: /npm_[A-Za-z0-9]{36}/g },
  { kind: "twilio-account-sid", re: /AC[0-9a-fA-F]{32}/g },
  { kind: "twilio-api-key", re: /SK[0-9a-fA-F]{32}/g },
  { kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    // A sensitive word as a whole `_`-delimited token inside an identifier (so
    // aws_secret_access_key / OPENAI_API_KEY / DATABASE_PASSWORD match) followed by an
    // assignment of an 8+ char value. Token-bounded to avoid prose ("the password is…")
    // and look-alikes ("secretary = …", "tokenize the input").
    kind: "generic-secret-assignment",
    re: /(?<![A-Za-z0-9_])(?:[A-Za-z0-9]+_)*(?:password|passwd|secret|token|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|credentials?)(?:_[A-Za-z0-9]+)*\s*[:=]\s*["']?[^\s"']{8,}/gi,
  },
];

/**
 * All patterns scanned by {@link findSecrets} / {@link hasSecrets}: our hand-tuned
 * {@link SECRET_PATTERNS} FIRST (so on an overlapping start index their more specific
 * attribution wins the dedupe), then the gitleaks-derived {@link GITLEAKS_PATTERNS}
 * which widen coverage to providers we don't hand-maintain. Internal — the public API is
 * unchanged.
 */
const ALL_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  ...SECRET_PATTERNS,
  ...GITLEAKS_PATTERNS,
];

/**
 * Mask a matched secret for reporting: keep the first 4 and last 2 characters, replace
 * the middle with "...". Short matches degrade gracefully to all-asterisks so the raw
 * value is never reconstructable from the preview.
 */
function maskPreview(match: string): string {
  if (match.length <= 6) return "*".repeat(match.length);
  return `${match.slice(0, 4)}...${match.slice(-2)}`;
}

/**
 * Scan `text` with every pattern in {@link ALL_PATTERNS} (our hand-tuned
 * {@link SECRET_PATTERNS} first, then {@link GITLEAKS_PATTERNS}) and return the matches,
 * deduplicated by start index and sorted by position. When two patterns hit the same
 * index, the earlier (more specific) pattern wins. Previews are masked — the raw secret
 * is never returned.
 */
export function findSecrets(text: string): SecretMatch[] {
  const byIndex = new Map<number, SecretMatch>();

  for (const { kind, re } of ALL_PATTERNS) {
    // Reset lastIndex: patterns are module-level and shared across calls.
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const value = m[0];
      // Guard against zero-width matches spinning forever.
      if (value.length === 0) {
        re.lastIndex += 1;
        continue;
      }
      if (!byIndex.has(m.index)) {
        byIndex.set(m.index, {
          kind,
          index: m.index,
          length: value.length,
          preview: maskPreview(value),
        });
      }
    }
  }

  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/** True if `text` contains at least one detected secret. */
export function hasSecrets(text: string): boolean {
  for (const { re } of ALL_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) return true;
  }
  return false;
}

/**
 * Replace every detected secret in `text` with a `[REDACTED:<kind>]` placeholder,
 * preserving all surrounding content. Overlapping/duplicate matches are handled by
 * {@link findSecrets}; replacement runs right-to-left so earlier indices stay valid.
 */
export function redactSecrets(text: string): string {
  const matches = findSecrets(text);
  let out = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { kind, index, length } = matches[i]!;
    out = `${out.slice(0, index)}[REDACTED:${kind}]${out.slice(index + length)}`;
  }
  return out;
}
