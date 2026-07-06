/**
 * Embeddings seam (ADR-0005 / ADR-0021). A pluggable `Embedder` turns text into vectors so the
 * curation gate can catch *semantic* near-duplicates the lexical (Jaccard) gate misses. The whole
 * feature is off unless the `semanticDedup` flag is on (ADR-0009); with it off no embedder is ever
 * resolved and behaviour is byte-identical to the lexical-only path.
 *
 * Design (ADR-0021):
 * - **local-first, no mandatory external service.** The `local` provider dynamically imports an
 *   embedding model package that is NOT a dependency of Commonwealth — the base install pulls
 *   nothing extra; a team installs the model package only when it enables the feature.
 * - **hosted is opt-in and explicit.** It sends note text to a third-party API; only selected by
 *   `embeddings.provider: "hosted"` with an endpoint, never a default.
 * - vectors live in the derived, disposable SQLite index (see `index-db.ts`), never a second store.
 */

/** A pluggable text→vector embedder. Returns one unit-or-raw vector per input, in order. */
export interface Embedder {
  embed(texts: string[]): Promise<Float32Array[]>;
}

/**
 * Brain-level embeddings configuration (lives in `.commonwealth/config.json`, ADR-0009). Inert
 * unless the `semanticDedup` feature flag is on. `provider` defaults to `local` (the recommended,
 * on-machine choice when a team opts in); `threshold` is the cosine similarity at/above which two
 * notes are treated as near-duplicates.
 */
export interface EmbeddingsConfig {
  provider: "none" | "local" | "hosted";
  /** Model id for the selected provider (provider-specific default when omitted). */
  model?: string;
  /** Cosine similarity ≥ this ⇒ near-duplicate. */
  threshold: number;
  /** Hosted only: the embeddings endpoint URL (OpenAI-compatible `{ data: [{ embedding }] }`). */
  endpoint?: string;
  /** Hosted only: env var holding the bearer token (default `COMMONWEALTH_EMBED_API_KEY`). */
  apiKeyEnv?: string;
}

/**
 * Cosine similarity of two vectors (0–1 for the non-negative embeddings we use; defined on
 * [-1, 1] in general). Returns 0 for empty, length-mismatched, or zero-magnitude inputs so a
 * bad pair can never masquerade as a perfect match.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Resolve an {@link Embedder} for a brain's embeddings config, or `null` when no embedder applies
 * (`provider: "none"`). May throw for a misconfigured/absent provider (e.g. the local model
 * package isn't installed) — callers gate this behind the `semanticDedup` flag and degrade
 * gracefully rather than crash.
 */
export async function embedProvider(config: EmbeddingsConfig): Promise<Embedder | null> {
  switch (config.provider) {
    case "none":
      return null;
    case "local":
      return loadLocalEmbedder(config.model);
    case "hosted":
      return loadHostedEmbedder(config);
    default:
      return null;
  }
}

/**
 * Package name of the optional local embedding model runtime. Held in a variable (not a literal
 * import specifier) so the bundler leaves it as a runtime import and TypeScript doesn't require
 * its types — it is intentionally NOT a dependency of Commonwealth (ADR-0021 base-install-light).
 */
const LOCAL_MODEL_PKG = "@xenova/transformers";
/** Default sentence-embedding model for the local provider (small, ~384-dim, offline once cached). */
const DEFAULT_LOCAL_MODEL = "Xenova/all-MiniLM-L6-v2";

/**
 * Load the local, on-machine embedder by dynamically importing {@link LOCAL_MODEL_PKG}. Note text
 * never leaves the machine. Throws an actionable error when the package isn't installed, since it
 * is deliberately not bundled — enabling `semanticDedup` with the `local` provider is the team's
 * signal to install it.
 */
async function loadLocalEmbedder(model: string = DEFAULT_LOCAL_MODEL): Promise<Embedder> {
  const pkg = LOCAL_MODEL_PKG;
  let mod: {
    pipeline: (
      task: string,
      model: string,
    ) => Promise<
      (
        text: string,
        opts: { pooling: string; normalize: boolean },
      ) => Promise<{ data: ArrayLike<number> }>
    >;
  };
  try {
    mod = (await import(pkg)) as typeof mod;
  } catch {
    throw new Error(
      `semanticDedup is enabled with the "local" embeddings provider, but the optional model ` +
        `package "${pkg}" is not installed. Install it on the brain host (e.g. ` +
        `\`pnpm add ${pkg}\`), or set embeddings.provider to "hosted"/"none" in ` +
        `.commonwealth/config.json.`,
    );
  }
  const extractor = await mod.pipeline("feature-extraction", model);
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      const out: Float32Array[] = [];
      for (const text of texts) {
        const res = await extractor(text, { pooling: "mean", normalize: true });
        out.push(Float32Array.from(res.data as ArrayLike<number>, Number));
      }
      return out;
    },
  };
}

/** Minimal `fetch` surface the hosted embedder needs (overridable in tests). */
type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}>;

/**
 * Build a hosted embedder that POSTs `{ model, input }` to an OpenAI-compatible embeddings
 * endpoint and reads `data[].embedding`. Note text IS sent to that third party — this is opt-in,
 * explicit config only. `fetchImpl` is injectable for tests; production uses the global `fetch`.
 */
export function loadHostedEmbedder(
  config: EmbeddingsConfig,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Embedder {
  const endpoint = config.endpoint;
  if (!endpoint || endpoint.length === 0) {
    throw new Error(
      `embeddings.provider is "hosted" but embeddings.endpoint is not set in ` +
        `.commonwealth/config.json.`,
    );
  }
  const model = config.model ?? "text-embedding-3-small";
  const apiKey = process.env[config.apiKeyEnv ?? "COMMONWEALTH_EMBED_API_KEY"];
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!res.ok) {
        throw new Error(`hosted embeddings request failed: ${res.status} ${res.statusText}`);
      }
      const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
      const data = json.data ?? [];
      return data.map((d) => Float32Array.from(d.embedding));
    },
  };
}
