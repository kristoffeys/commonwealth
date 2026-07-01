import { describe, expect, it } from "vitest";
import { findSecrets, hasSecrets, redactSecrets, SECRET_PATTERNS } from "../src/secrets.js";

/** Realistic (fake) samples, one per pattern kind. */
const SAMPLES: Record<string, string> = {
  "aws-access-key-id": "AKIAIOSFODNN7EXAMPLE",
  "github-token": "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "github-pat": "github_pat_11ABCDEFG0abcdefghij_klmnopqrstuvwxyz",
  "anthropic-api-key": "sk-ant-api03-_AbCdEfGhIjKlMnOpQrStUv", // body contains "_"
  "openai-api-key": "sk-proj-abcdefghijklmnopqrstuvwxyz", // modern prefixed form
  "google-api-key": "AIzaSyA1234567890abcdefghijklmnopqrstuv0",
  "google-oauth-token": "ya29.a0AfH6SMByExampleTokenValue123",
  "slack-token": "xoxb-1234567890-abcdefghijklmno",
  "slack-webhook": "https://hooks.slack.com/services/T00000000/B11111111/abcXYZdefGHI",
  "stripe-key": "sk_live_4eC39HqLyjWDarjtT1zdp7dc",
  "sendgrid-key": "SG.abcdefghijklmnop.qrstuvwxyz0123456789ABCDEFG",
  "npm-token": "npm_abcdefghijklmnopqrstuvwxyz0123456789",
  "twilio-account-sid": "AC0123456789abcdef0123456789abcdef",
  "twilio-api-key": "SK0123456789abcdef0123456789abcdef",
  "private-key": "-----BEGIN RSA PRIVATE KEY-----",
  "generic-secret-assignment": "password = hunter2xyzlong",
};

describe("SECRET_PATTERNS", () => {
  it("has a realistic sample for every pattern kind", () => {
    for (const { kind } of SECRET_PATTERNS) {
      expect(SAMPLES[kind], `missing sample for ${kind}`).toBeDefined();
    }
  });

  for (const { kind } of SECRET_PATTERNS) {
    it(`detects a ${kind}`, () => {
      const sample = SAMPLES[kind]!;
      expect(hasSecrets(sample)).toBe(true);
      const found = findSecrets(sample);
      expect(found.length).toBeGreaterThan(0);
      // A specific-provider sample must be attributed to that provider (order matters),
      // except that AWS ids are also caught only as aws; generic samples are generic.
      const kinds = found.map((f) => f.kind);
      expect(kinds).toContain(kind === "openai-api-key" ? "openai-api-key" : kind);
    });
  }
});

describe("findSecrets", () => {
  it("returns masked previews and never the raw secret", () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const found = findSecrets(`aws key: ${secret}`);
    expect(found).toHaveLength(1);
    const [m] = found;
    expect(m!.kind).toBe("aws-access-key-id");
    expect(m!.preview).not.toContain(secret);
    expect(m!.preview).toBe("AKIA...LE");
    expect(m!.length).toBe(secret.length);
    // The reported slice is exactly the secret — position is accurate.
    const text = `aws key: ${secret}`;
    expect(text.slice(m!.index, m!.index + m!.length)).toBe(secret);
  });

  it("dedupes by index and sorts by position", () => {
    const text = "first AKIAIOSFODNN7EXAMPLE then password = superSecretValue";
    const found = findSecrets(text);
    expect(found.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < found.length; i++) {
      expect(found[i]!.index).toBeGreaterThan(found[i - 1]!.index);
    }
  });

  it("short generic values below the 8-char threshold are masked, not leaked", () => {
    // A slightly-longer secret to exercise the mask branch fully.
    const found = findSecrets("token=abcdefgh");
    expect(found).toHaveLength(1);
    expect(found[0]!.preview).not.toContain("abcdefgh");
  });
});

describe("redactSecrets", () => {
  it("replaces each match with [REDACTED:<kind>]", () => {
    const text = "key AKIAIOSFODNN7EXAMPLE end";
    expect(redactSecrets(text)).toBe("key [REDACTED:aws-access-key-id] end");
  });

  it("redacts multiple secrets without leaking either", () => {
    const text = "a AKIAIOSFODNN7EXAMPLE b ghp_abcdefghijklmnopqrstuvwxyz0123456789 c";
    const out = redactSecrets(text);
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).toContain("[REDACTED:aws-access-key-id]");
    expect(out).toContain("[REDACTED:github-token]");
  });
});

describe("false-positive guards", () => {
  const clean = [
    "the password is rotated monthly",
    "the password is stored securely",
    "tokenize the input before parsing",
    "we need to secret away some budget", // no assignment
    "commit 9f3d2a1b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f", // git SHA
    "id 550e8400-e29b-41d4-a716-446655440000", // UUID
    "The access token flow uses PKCE for public clients.",
    "secretary = jane_doe_smith_here", // "secret" is not a whole token
    "author = somereallylongname", // "auth" is not the auth_token keyword
    "monkey = businesslogic123", // no keyword at all
    "AC power adapter model number 12v", // AC not followed by 32 hex
    "background = darkslategray_value1", // no sensitive token
  ];

  for (const text of clean) {
    it(`does NOT flag: ${text}`, () => {
      expect(hasSecrets(text)).toBe(false);
      expect(findSecrets(text)).toHaveLength(0);
    });
  }
});

describe("true positives for assignments", () => {
  it("flags aws_secret_access_key = AKIA...", () => {
    expect(hasSecrets("aws_secret_access_key = AKIAIOSFODNN7EXAMPLE")).toBe(true);
  });

  it("flags password = hunter2long", () => {
    expect(hasSecrets("password = hunter2long")).toBe(true);
  });

  it("flags compound env-var assignments (the common .env paste)", () => {
    expect(hasSecrets("OPENAI_API_KEY=sk-abcdefghij1234567890")).toBe(true);
    expect(hasSecrets("DATABASE_PASSWORD=hunter2longvalue")).toBe(true);
    expect(hasSecrets("aws_secret_access_key = wJalrXUtnFEMIexamplekey")).toBe(true);
  });

  it("flags modern OpenAI (sk-proj-) and underscore Anthropic keys", () => {
    expect(hasSecrets("sk-proj-Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9")).toBe(true);
    expect(hasSecrets("sk-ant-api03-_AbCdEfGhIjKlMnOpQrStUv")).toBe(true);
  });
});
