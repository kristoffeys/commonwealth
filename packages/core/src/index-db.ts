import { promises as fs } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { loadBrainConfig } from "./config.js";
import { cosineSimilarity, embedProvider, type Embedder } from "./embed.js";
import { listNoteFiles, listNotes } from "./notes.js";
import { loadProjectAliasMap, resolveNoteProject, type ProjectAliasMap } from "./projects.js";
import { type Note, type NoteKind } from "./schema.js";

export interface SearchOptions {
  kind?: NoteKind;
  /** Restrict to notes from one originating project (frontmatter `source`; ADR-0015). */
  source?: string;
  /** Max results (default 20). */
  limit?: number;
  /**
   * Include superseded notes (archaeology). Default false: retrieval returns CANON, not the old
   * versions the consolidation/supersede path replaced (#133). Set true for history/audit views.
   */
  includeSuperseded?: boolean;
  /**
   * Embedder for hybrid semantic retrieval (ADR-0025), mirroring {@link BuildIndexOptions}: pass
   * `null` to force lexical-only, an explicit {@link Embedder} (tests) to bypass config, or omit
   * to resolve from the brain config IFF the `semanticSearch` flag is on. Independent of
   * `semanticDedup`.
   */
  embedder?: Embedder | null;
  /**
   * Hard timeout (ms) for embedding the query before falling back to lexical-only. Default
   * {@link EMBED_QUERY_TIMEOUT_MS}; exposed mainly so tests can exercise the timeout path.
   */
  embedTimeoutMs?: number;
  /**
   * Strict retrieval (#236, after MAMA's strict mode): the minimum lexical support a candidate needs
   * to survive fusion. Default `0` = today's permissive behavior (no candidate is ever dropped).
   * Support is the count of distinct query tokens with a lexical anchor on the note, where an anchor
   * is EITHER the note arriving in the (OR-expanded, #209) lexical candidate list — which already
   * gives it support ≥ 1 — OR a query token appearing in the note's title/tags. So `1` keeps every
   * lexically-arrived hit and every title/tag-keyword hit but rejects pure vector noise: an
   * embedding-near note with zero lexical/title/tag overlap. Only ever prunes SEMANTIC-only
   * candidates in the hybrid path; the lexical-only path is untouched (every lexical hit has
   * support ≥ 1 by construction), so lexical brains stay byte-identical regardless of this value.
   */
  minLexicalSupport?: number;
  /**
   * Attach per-result {@link ResultDiagnostics} provenance (#236) explaining WHY each hit ranked:
   * its lexical/semantic ranks, fused score, and evidence tier. Off by default and purely additive —
   * when unset, results carry no `diagnostics` field and the retrieval path is unchanged (no extra
   * allocations). Surfaced through `ask` hits and `recall --verbose`.
   */
  diagnostics?: boolean;
}

/**
 * Per-result retrieval provenance (#236): where a hit came from and how it scored, so an agent (or
 * `recall --verbose`) can see the evidence class behind a citation instead of trusting an opaque
 * rank. In the hybrid path `rrfScore` is the fused reciprocal-rank score; in the lexical-only path
 * there is no fusion, so it is the (negated BM25) lexical score and `semanticRank` is always null.
 */
export interface ResultDiagnostics {
  /** 1-based rank in the lexical (BM25 / OR-fallback) candidate list, or null if absent from it. */
  lexicalRank: number | null;
  /** 1-based rank in the semantic (cosine) candidate list, or null if absent / no semantic path. */
  semanticRank: number | null;
  /** The scalar this result was ranked by (fused RRF in hybrid; negated BM25 in lexical-only). */
  rrfScore: number;
  /** Evidence class: in both lists (`hybrid`), lexical-only, or semantic-only. */
  tier: "lexical" | "semantic" | "hybrid";
}

export interface SearchResult {
  id: string;
  kind: NoteKind;
  title: string;
  path: string;
  /** Originating project, when the note carries one. */
  source?: string;
  /** Highlighted excerpt around the match. */
  snippet: string;
  /** Relevance score (higher = better). */
  score: number;
  /** Retrieval provenance — present only when {@link SearchOptions.diagnostics} is set (#236). */
  diagnostics?: ResultDiagnostics;
}

/** Repo-relative location of the derived, disposable SQLite index. */
const INDEX_DIR = "index";
const DB_FILE = "commonwealth.db";

/** Absolute path to the SQLite index db for a brain. */
function dbPath(brainDir: string): string {
  return path.join(brainDir, INDEX_DIR, DB_FILE);
}

/** Row shape mirrored into the FTS5 table. */
interface IndexRow {
  id: string;
  kind: NoteKind;
  title: string;
  tags: string;
  body: string;
  path: string;
  source: string;
  /** Lifecycle status (`active`/`superseded`/`stale`/…), or "" for kinds without one. */
  status: string;
  /** 1 when this note has been superseded (its own `status`/`superseded_by`), else 0 (#133). */
  superseded: number;
}

/** True when a note is itself superseded — the read side of the create/supersede contract (#133). */
function isSuperseded(note: Note): boolean {
  const fm = note.frontmatter;
  if (fm.kind === "memory" || fm.kind === "decision") {
    if (typeof fm.superseded_by === "string" && fm.superseded_by.length > 0) return true;
  }
  return "status" in fm && fm.status === "superseded";
}

function toRow(note: Note): IndexRow {
  const fm = note.frontmatter;
  // `.passthrough()` (#81) widens known fields to `unknown` via its index signature, so guard the
  // status read with a typeof check (person notes have no status → "").
  const statusVal = (fm as { status?: unknown }).status;
  return {
    id: fm.id,
    kind: fm.kind,
    title: fm.title,
    tags: fm.tags.join(" "),
    body: note.body,
    path: note.path,
    source: fm.source ?? "",
    status: typeof statusVal === "string" ? statusVal : "",
    superseded: isSuperseded(note) ? 1 : 0,
  };
}

/** Options for {@link buildIndex}. */
export interface BuildIndexOptions {
  /**
   * Embedder used to populate the `vectors` table (ADR-0021). When omitted, the embedder is
   * resolved from the brain config IFF the `semanticDedup` flag is on; pass `null` to force a
   * vector-free build, or an explicit {@link Embedder} (e.g. in tests) to bypass config.
   */
  embedder?: Embedder | null;
}

/** Title + body text of a note, embedded as its semantic representation (matches the dedup gate). */
function noteEmbedText(note: Note): string {
  return `${note.frontmatter.title} ${note.body}`;
}

/** A note id and its embedding, staged for insertion into the `vectors` table. */
interface VectorRow {
  id: string;
  vec: Float32Array;
}

/**
 * (Re)build the derived SQLite index from the markdown notes under `brainDir`: an FTS5 table for
 * lexical search (ADR-0005) and, when semantic dedup is enabled, a `vectors` table of per-note
 * embeddings (ADR-0021). The index lives at `index/commonwealth.db`, is gitignored, and is fully
 * disposable — it can always be rebuilt from the files.
 *
 * Performs a FULL rebuild each call (DROP + CREATE) so the result is a pure function of the note
 * set (given a stable embedder) and running it twice is idempotent. Returns the counts.
 */
export async function buildIndex(
  brainDir: string,
  opts?: BuildIndexOptions,
): Promise<{ indexed: number; embedded: number }> {
  await fs.mkdir(path.join(brainDir, INDEX_DIR), { recursive: true });
  const notes = await listNotes(brainDir);

  // Snapshot the cheap staleness signature of the note files we are about to index (#234). Stored
  // alongside the index so a later search can detect hand-edits/adds/removes since this build and
  // reconcile-on-read. Computed here (from the same file set) so the stored signature always
  // describes exactly what the index contains.
  const signature = await computeBrainSignature(brainDir);

  // Resolve the embedder BEFORE opening the db and OUTSIDE the sync transaction: embedding is
  // async and better-sqlite3 transactions are synchronous, so all vectors must exist up front.
  // Default (flag off, or resolution/embed fails) is a vector-free build — never a crash — so a
  // misconfigured or uninstalled local provider degrades to lexical-only rather than breaking
  // every index rebuild (and therefore search/sync).
  const vectorRows = await computeVectors(brainDir, notes, opts);

  const db = new Database(dbPath(brainDir));
  try {
    // Full rebuild + read-only queries: the default rollback journal leaves no
    // persistent sidecar files (unlike WAL's -wal/-shm), keeping index/ clean.
    //
    // Do the DROP + CREATE + inserts in ONE transaction so an interrupt (crash, SIGTERM)
    // rolls the whole thing back: the db is never left with the old table dropped and the
    // new one missing/half-populated, which would make `search` throw "no such table"
    // forever (#101). Either the previous index survives intact, or the new one lands whole.
    const rebuild = db.transaction((rows: IndexRow[], vecs: VectorRow[]) => {
      db.exec("DROP TABLE IF EXISTS notes_fts;");
      // `path` is UNINDEXED: stored/returned but not part of the full-text match.
      db.exec(
        "CREATE VIRTUAL TABLE notes_fts USING fts5(" +
          "id, kind, title, tags, body, path UNINDEXED, source UNINDEXED, " +
          "status UNINDEXED, superseded UNINDEXED" +
          ");",
      );
      const insert = db.prepare(
        "INSERT INTO notes_fts (id, kind, title, tags, body, path, source, status, superseded) " +
          "VALUES (@id, @kind, @title, @tags, @body, @path, @source, @status, @superseded);",
      );
      for (const row of rows) insert.run(row);

      // The `vectors` table is always (re)created for schema stability — empty when no embedder
      // ran — so `loadVectors` never has to special-case an older, table-less index.
      db.exec("DROP TABLE IF EXISTS vectors;");
      db.exec(
        "CREATE TABLE vectors (id TEXT PRIMARY KEY, dim INTEGER NOT NULL, vec BLOB NOT NULL);",
      );
      const insertVec = db.prepare("INSERT INTO vectors (id, dim, vec) VALUES (@id, @dim, @vec);");
      for (const v of vecs) {
        insertVec.run({
          id: v.id,
          dim: v.vec.length,
          // Copy the exact backing bytes of the Float32Array (respecting byteOffset) into a Buffer.
          vec: Buffer.from(v.vec.buffer, v.vec.byteOffset, v.vec.byteLength),
        });
      }

      // Persist the staleness signature (#234) in the same transaction, so the index and the
      // signature describing it always land together (or roll back together).
      db.exec("DROP TABLE IF EXISTS meta;");
      db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
      db.prepare("INSERT INTO meta (key, value) VALUES (?, ?);").run(
        SIGNATURE_KEY,
        JSON.stringify(signature),
      );
    });
    rebuild(notes.map(toRow), vectorRows);

    return { indexed: notes.length, embedded: vectorRows.length };
  } finally {
    db.close();
  }
}

/**
 * Embed every note for the `vectors` table, or return `[]` when no semantic feature is on / no
 * embedder is available. Resolution and embedding are best-effort: any failure (flag off, provider
 * absent, model error, count mismatch) yields a vector-free build so a rebuild — and therefore
 * search and sync — never crashes on an embeddings misconfiguration. Provider-resolution failures
 * warn ONLY for an explicitly-chosen provider (`hosted`); the factory-default `local` provider with
 * the optional model package absent is the untouched default state and stays silent.
 */
async function computeVectors(
  brainDir: string,
  notes: Note[],
  opts?: BuildIndexOptions,
): Promise<VectorRow[]> {
  let embedder: Embedder | null;
  if (opts && "embedder" in opts) {
    embedder = opts.embedder ?? null;
  } else {
    let config;
    try {
      config = await loadBrainConfig(brainDir);
    } catch {
      return [];
    }
    // Vectors back BOTH the dedup gate (ADR-0021) and hybrid retrieval (ADR-0025), so populate
    // them when EITHER feature is on and a provider resolves.
    const wantsVectors = config.features.semanticDedup || config.features.semanticSearch;
    if (!wantsVectors) {
      embedder = null;
    } else {
      try {
        embedder = await embedProvider(config.embeddings);
      } catch (err) {
        // semanticSearch is default-ON and the FACTORY-DEFAULT provider is `local`, which scaffold
        // writes into every brain's config. With the optional model package absent, resolution
        // throws — but that is the untouched default state, not a misconfiguration, and firing on
        // every rebuild/sync (a fresh short-lived process each time) would be ambient noise for
        // teams that opted into nothing. So: `local` resolution failures are SILENT. A provider the
        // team explicitly switched to (`hosted`) failing to resolve IS a real, opted-in problem —
        // keep it loud. (Surfacing "you enabled semanticSearch but the local model package is
        // missing" belongs in a future `commonwealth doctor`, not on the hot rebuild path.)
        if (config.embeddings.provider !== "local") {
          warnEmbedderUnavailableOnce(errMessage(err));
        }
        return [];
      }
    }
  }
  if (!embedder || notes.length === 0) return [];

  try {
    const vecs = await embedder.embed(notes.map(noteEmbedText));
    if (vecs.length !== notes.length) {
      console.error(
        `[commonwealth] semantic index skipped: embedder returned ${vecs.length} vectors for ` +
          `${notes.length} notes.`,
      );
      return [];
    }
    return notes.map((n, i) => ({ id: n.frontmatter.id, vec: vecs[i]! }));
  } catch (err) {
    console.error(`[commonwealth] semantic index skipped (embed failed): ${errMessage(err)}`);
    return [];
  }
}

/** Message text of an unknown thrown value. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Distinct "embedder unavailable" messages already logged this process (dedupe the noise). */
const embedderWarned = new Set<string>();

/** Log an "embedder unavailable" warning at most once per distinct message per process. */
function warnEmbedderUnavailableOnce(message: string): void {
  if (embedderWarned.has(message)) return;
  embedderWarned.add(message);
  console.error(`[commonwealth] semantic index skipped (embedder unavailable): ${message}`);
}

/**
 * Load the per-note embeddings from the derived index as an id→vector map (ADR-0021). Returns an
 * empty map when the index or the `vectors` table doesn't exist yet, or is empty — so the semantic
 * gate simply no-ops (falls back to lexical) until an embedder-backed {@link buildIndex} has run.
 */
export async function loadVectors(brainDir: string): Promise<Map<string, Float32Array>> {
  const file = dbPath(brainDir);
  try {
    await fs.access(file);
  } catch {
    return new Map();
  }

  const db = new Database(file, { readonly: true });
  try {
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vectors'")
      .get();
    if (hasTable === undefined) return new Map();

    const rows = db.prepare("SELECT id, dim, vec FROM vectors").all() as Array<{
      id: string;
      dim: number;
      vec: Buffer;
    }>;
    const map = new Map<string, Float32Array>();
    for (const row of rows) {
      // Copy into a fresh, correctly-aligned Float32Array — a Buffer's underlying ArrayBuffer is
      // pooled and its byteOffset need not be 4-byte aligned, so we can't view it directly.
      const vec = new Float32Array(row.dim);
      const bytes = Math.min(row.vec.byteLength, vec.byteLength);
      new Uint8Array(vec.buffer).set(new Uint8Array(row.vec.buffer, row.vec.byteOffset, bytes));
      map.set(row.id, vec);
    }
    return map;
  } finally {
    db.close();
  }
}

/** True if the FTS table exists in an already-open db (survives a partial/interrupted build). */
function hasFtsTable(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notes_fts'")
    .get();
  return row !== undefined;
}

/** `meta` key under which the note-set staleness signature is stored (#234). */
const SIGNATURE_KEY = "signature";

/**
 * A cheap fingerprint of the note files on disk (#234): the file COUNT and the MAX mtime across
 * them. In practice every change to canon moves at least one of these — an add/remove shifts the
 * count, and a normal edit stamps mtime "now", above the previous max. Known blind spot: an edit
 * whose mtime is deliberately backdated below the untouched max on a non-max file, at constant
 * count, is missed until the next build — acceptable, since only tooling that rewrites mtimes
 * (not editors, not git) produces that shape. Comparison reads stats only, never note bodies.
 */
interface BrainSignature {
  count: number;
  maxMtimeMs: number;
}

/**
 * Compute the current {@link BrainSignature} by stat-ing every note file — O(files) stat calls,
 * no content reads. Files that vanish between the directory walk and the stat are skipped (a
 * concurrent delete simply lowers the count, which is itself a detected change).
 */
async function computeBrainSignature(brainDir: string): Promise<BrainSignature> {
  const files = await listNoteFiles(brainDir);
  let maxMtimeMs = 0;
  let count = 0;
  for (const rel of files) {
    try {
      const st = await fs.stat(path.join(brainDir, rel));
      count += 1;
      if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
    } catch {
      // Raced with a delete between walk and stat — treat as absent (lower count = a change).
    }
  }
  return { count, maxMtimeMs };
}

/** Read the signature stored in the index, or `null` when absent (no db / old index / no row). */
async function readStoredSignature(brainDir: string): Promise<BrainSignature | null> {
  const file = dbPath(brainDir);
  try {
    await fs.access(file);
  } catch {
    return null;
  }
  const db = new Database(file, { readonly: true });
  try {
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
      .get();
    if (hasTable === undefined) return null; // index built before #234 → force a reconcile rebuild
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(SIGNATURE_KEY) as
      { value: string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.value) as BrainSignature;
    if (typeof parsed.count !== "number" || typeof parsed.maxMtimeMs !== "number") return null;
    return parsed;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** How long a per-process staleness check is trusted before we re-stat (bounds rapid re-searches). */
const RECONCILE_TTL_MS = 5000;

/** Per-process time (epoch ms) of the last staleness check, keyed by resolved brain dir (#234). */
const reconcileChecked = new Map<string, number>();

/** Reset the reconcile TTL cache — tests only, so a fresh brain dir never inherits a stale stamp. */
export function __resetReconcileCacheForTests(): void {
  reconcileChecked.clear();
}

/**
 * Reconcile-on-read (#234): before serving results, cheaply detect whether canon changed since the
 * index was built and, if so, rebuild it — so hand-edited notes and files dropped in by a git pull
 * are honored WITHOUT the sync daemon or an explicit rebuild. The check is a single {@link
 * BrainSignature} comparison (O(files) stat calls, no body reads); a mismatch triggers a full
 * {@link buildIndex} (which re-embeds vectors when a provider is configured, mirroring its normal
 * gating). The check is memoized per process for {@link RECONCILE_TTL_MS} so a burst of searches
 * pays it once — the "daemonless tax, paid once when nothing changed" (agentcairn's framing).
 */
async function reconcileIfStale(brainDir: string): Promise<void> {
  const key = path.resolve(brainDir);
  const now = Date.now();
  const last = reconcileChecked.get(key);
  if (last !== undefined && now - last < RECONCILE_TTL_MS) return;
  reconcileChecked.set(key, now);

  const stored = await readStoredSignature(brainDir);
  const current = await computeBrainSignature(brainDir);
  if (stored && stored.count === current.count && stored.maxMtimeMs === current.maxMtimeMs) {
    return; // nothing changed on disk since the last build
  }
  await buildIndex(brainDir);
}

/**
 * Split a user query into FTS5 match tokens: each whitespace-separated word wrapped as a quoted
 * string, so punctuation in the query can't be parsed as an FTS operator. Returns [] for an
 * empty/whitespace query. The quoting is the shared basis for both the implicit-AND match (tokens
 * joined by spaces) and the OR fallback (tokens joined by ` OR `, #209).
 */
function toMatchTokens(query: string): string[] {
  return query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ""))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`);
}

/**
 * The bare, lowercased query tokens (the unquoted basis of {@link toMatchTokens}) — used by strict
 * retrieval (#236) to test title/tag keyword presence when scoring a candidate's lexical support.
 */
function toRawTokens(query: string): string[] {
  return query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ""))
    .filter((t) => t.length > 0)
    .map((t) => t.toLowerCase());
}

/** Hard cap on how long we wait for the query embedding before falling back to lexical (ADR-0025). */
const EMBED_QUERY_TIMEOUT_MS = 3000;
/** How many cosine candidates to fuse with the lexical list (full scan is fine at brain scale). */
const SEMANTIC_CANDIDATE_CAP = 50;
/** Standard reciprocal-rank-fusion constant (k=60): score += 1/(k + rank). */
const RRF_K = 60;

/** Per-note metadata read from the FTS table, used to filter and label semantic candidates. */
interface NoteMeta {
  kind: NoteKind;
  title: string;
  /** Space-joined tags — part of a note's title/tag keyword surface for strict support (#236). */
  tags: string;
  path: string;
  source: string;
  status: string;
  superseded: boolean;
}

/**
 * Resolve the ingredients for hybrid semantic retrieval, or `null` to fall back to lexical-only.
 * Returns null (never throws) for every degradation path (ADR-0025): flag off, no provider,
 * no/empty vectors table, or an embed call that throws OR exceeds the timeout — so semantic search
 * can only ever *add* to the lexical result, never break or slow it past a bounded cliff.
 */
async function resolveSemantic(
  brainDir: string,
  query: string,
  opts: SearchOptions | undefined,
): Promise<{ queryVec: Float32Array; vectors: Map<string, Float32Array> } | null> {
  let embedder: Embedder | null;
  if (opts && "embedder" in opts) {
    // Explicit injection (tests) bypasses config entirely, mirroring buildIndex: null = force off.
    embedder = opts.embedder ?? null;
  } else {
    embedder = await resolveConfiguredEmbedder(brainDir);
  }
  if (!embedder) return null;

  const vectors = await loadVectors(brainDir);
  if (vectors.size === 0) return null;

  const timeoutMs = opts?.embedTimeoutMs ?? EMBED_QUERY_TIMEOUT_MS;
  try {
    const vecs = await withTimeout(embedder.embed([query]), timeoutMs);
    const queryVec = vecs[0];
    if (!queryVec || queryVec.length === 0) return null;
    return { queryVec, vectors };
  } catch {
    // embed() threw, or the timeout won the race → lexical-only.
    return null;
  }
}

/**
 * Per-process cache of the config-resolved query embedder, keyed by brain + embeddings config.
 * Loading the `local` provider imports and warms a model pipeline (seconds) — without this, a
 * long-lived host (the MCP server) would pay that on every search. Failures resolve to `null` so a
 * missing model package degrades to lexical-only without re-attempting the costly import each call.
 */
const configuredEmbedderCache = new Map<string, Promise<Embedder | null>>();

/** Resolve the query embedder from a brain's config when `semanticSearch` is on (cached). */
async function resolveConfiguredEmbedder(brainDir: string): Promise<Embedder | null> {
  let config;
  try {
    config = await loadBrainConfig(brainDir);
  } catch {
    return null;
  }
  if (!config.features.semanticSearch) return null;
  const key = `${path.resolve(brainDir)}::${JSON.stringify(config.embeddings)}`;
  let resolved = configuredEmbedderCache.get(key);
  if (!resolved) {
    // Convert any resolution error (e.g. local model package absent) to null and cache it, so the
    // expensive/failing import runs at most once per process per config.
    resolved = embedProvider(config.embeddings).catch(() => null);
    configuredEmbedderCache.set(key, resolved);
  }
  return resolved;
}

/** Resolve `p`, or reject once `ms` elapses — bounds the semantic path's added latency. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("embed timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Lexical + semantic hybrid search over the derived index (ADR-0025). Builds the index on first
 * use if it is missing, and reconcile-on-read (#234) rebuilds it when the note files changed since
 * the last build — so hand-edits and out-of-band git pulls are reflected WITHOUT an explicit
 * rebuild (the check is a cheap per-process signature comparison; see {@link reconcileIfStale}).
 *
 * The lexical layer runs FTS5's implicit-AND first; when that returns nothing and the query has ≥2
 * tokens it retries the same tokens joined by ` OR ` (#209), so natural-language questions whose
 * stopwords (did/we/before) would never all co-occur still retrieve — bm25 keeps multi-term
 * matches ranked above single-term ones. The OR fallback honors the same kind/source/superseded
 * filters and stale demotion as the AND query.
 *
 * When an embeddings provider is configured and the `semanticSearch` flag is on, the BM25 list is
 * fused with a cosine-ranked list (over the per-note `vectors` table) via reciprocal-rank fusion,
 * so paraphrases and stopword-heavy questions that FTS5's implicit-AND misses still retrieve. The
 * lexical list feeding the fusion is the AND result, or the OR-fallback result when AND is empty,
 * so lexical-OR hits and semantic hits both join RRF. All degradation paths (no provider, no
 * vectors, embed failure/timeout) return exactly the lexical result. Semantic candidates are
 * filtered by the SAME note metadata (kind/source/superseded) as lexical hits, and stale notes
 * stay demoted below fresh ones after fusion.
 *
 * NOTE: with the semantic path active, `score` is the RRF value (Σ 1/(60+rank) over the lists a
 * note appears in), NOT the negated BM25 of the lexical-only path. It remains strictly ordinal —
 * higher = better — which is all callers rely on (coverage checks `> 0`, never its magnitude).
 */
export async function search(
  brainDir: string,
  query: string,
  opts?: SearchOptions,
): Promise<SearchResult[]> {
  // Build the index on demand if it has never been created.
  try {
    await fs.access(dbPath(brainDir));
  } catch {
    await buildIndex(brainDir);
  }

  // Self-heal (#101): the db file can exist but lack `notes_fts` — e.g. a build interrupted
  // before this fix, or an externally-truncated db. Detect the missing table and rebuild once,
  // so search recovers instead of throwing "no such table: notes_fts" on every call forever.
  {
    const probe = new Database(dbPath(brainDir), { readonly: true });
    let healthy: boolean;
    try {
      healthy = hasFtsTable(probe);
    } finally {
      probe.close();
    }
    if (!healthy) await buildIndex(brainDir);
  }

  // Reconcile-on-read (#234): rebuild if canon changed on disk since the index was built.
  await reconcileIfStale(brainDir);

  const tokens = toMatchTokens(query);
  if (tokens.length === 0) return [];
  const match = tokens.join(" ");
  // OR fallback (#209): only meaningful with ≥2 tokens (a single token's AND and OR are identical).
  const matchOr = tokens.length >= 2 ? tokens.join(" OR ") : null;

  const limit = opts?.limit ?? 20;
  // Resolve the semantic ingredients BEFORE opening the search db (loadVectors uses its own
  // connection). Any failure yields null → the untouched lexical path below.
  const semantic = await resolveSemantic(brainDir, query, opts);

  const db = new Database(dbPath(brainDir), { readonly: true });
  try {
    if (!semantic) return lexicalSearch(db, match, matchOr, opts, limit);
    return hybridSearch(db, query, match, matchOr, opts, limit, semantic);
  } finally {
    db.close();
  }
}

/** Raw FTS5 row shape for a lexical query, before mapping to {@link SearchResult}. */
interface LexRow {
  id: string;
  kind: NoteKind;
  title: string;
  path: string;
  source: string;
  snippet: string;
  score: number;
}

/**
 * Run the lexical (FTS5) query for one MATCH expression, applying every filter (kind/source/
 * superseded) and stale demotion. `match` is either the implicit-AND expression or the OR
 * fallback — the SQL is identical, so both paths share filtering and ordering exactly (#209).
 */
function runLexicalQuery(
  db: Database.Database,
  match: string,
  opts: SearchOptions | undefined,
  limit: number,
): LexRow[] {
  // snippet(): excerpt of the body column (index 4) with matches marked by [ ].
  // bm25() returns a negative-ish score where lower = more relevant, so we negate
  // it to expose a positive score where higher = better.
  const params: (string | number)[] = [match];
  let sql =
    "SELECT id, kind, title, path, source, " +
    "snippet(notes_fts, 4, '[', ']', '…', 12) AS snippet, " +
    "-bm25(notes_fts) AS score " +
    "FROM notes_fts WHERE notes_fts MATCH ?";
  if (opts?.kind) {
    sql += " AND kind = ?";
    params.push(opts.kind);
  }
  if (opts?.source) {
    sql += " AND source = ?";
    params.push(opts.source);
  }
  // Canon, not archaeology (#133): drop superseded notes unless explicitly asked for. Because a
  // note is superseded iff its OWN status/superseded_by says so, filtering per-note collapses a
  // whole supersede chain to its head (every non-head link is itself superseded) — cycle-safe,
  // no graph walk needed.
  if (!opts?.includeSuperseded) sql += " AND superseded = 0";
  // Demote stale notes below fresh ones; relevance (bm25) orders within each tier.
  sql += " ORDER BY (status = 'stale'), bm25(notes_fts) LIMIT ?";
  params.push(limit);

  return db.prepare(sql).all(...params) as LexRow[];
}

/**
 * The lexical-only (FTS5) result — the pre-ADR-0025 behaviour, kept byte-identical for brains
 * with no embeddings provider (or `semanticSearch` off). `score` is negated BM25 (higher = better).
 * Runs the implicit-AND query first; if it matches nothing and an OR fallback exists (≥2 tokens),
 * retries with the OR expression (#209) so stopword-heavy questions still retrieve.
 */
function lexicalSearch(
  db: Database.Database,
  match: string,
  matchOr: string | null,
  opts: SearchOptions | undefined,
  limit: number,
): SearchResult[] {
  let rows = runLexicalQuery(db, match, opts, limit);
  if (rows.length === 0 && matchOr) rows = runLexicalQuery(db, matchOr, opts, limit);

  // Strict retrieval (#236) is a no-op here: the lexical-only path has no semantic-only candidates
  // to guard against — every hit arrived lexically (support ≥ 1) — so `minLexicalSupport` never
  // drops a row and this path stays byte-identical to the pre-#236 behavior. Diagnostics, when
  // requested, describe the lexical ranking directly (no fusion happened).
  const withDiagnostics = opts?.diagnostics === true;
  return rows.map((r, i) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    path: r.path,
    ...(r.source ? { source: r.source } : {}),
    snippet: r.snippet,
    score: r.score,
    ...(withDiagnostics
      ? {
          diagnostics: {
            lexicalRank: i + 1,
            semanticRank: null,
            rrfScore: r.score,
            tier: "lexical",
          } satisfies ResultDiagnostics,
        }
      : {}),
  }));
}

/** One ranked lexical candidate for fusion: relevance-ordered (bm25), pre-stale-demotion. */
interface LexCandidate {
  id: string;
  snippet: string;
}

/**
 * Hybrid retrieval (ADR-0025): fuse the BM25-ordered lexical candidates with the cosine-ordered
 * semantic candidates via RRF, apply stale demotion after fusion, and cap at `limit`.
 */
function hybridSearch(
  db: Database.Database,
  query: string,
  match: string,
  matchOr: string | null,
  opts: SearchOptions | undefined,
  limit: number,
  semantic: { queryVec: Float32Array; vectors: Map<string, Float32Array> },
): SearchResult[] {
  const includeSuperseded = opts?.includeSuperseded ?? false;
  const kind = opts?.kind;
  const source = opts?.source;

  // Metadata for every indexed note — the single source of truth for filtering the semantic
  // candidates identically to the lexical ones, and for labelling the fused output.
  const meta = loadNoteMeta(db);

  // Lexical candidates: relevance-ordered (bm25 only, no stale demotion — that is applied once,
  // after fusion), filtered like the lexical path, capped at max(limit, CAP) to feed the fusion.
  const cap = Math.max(limit, SEMANTIC_CANDIDATE_CAP);
  let lexSql =
    "SELECT id, snippet(notes_fts, 4, '[', ']', '…', 12) AS snippet " +
    "FROM notes_fts WHERE notes_fts MATCH ?";
  const filterParams: (string | number)[] = [];
  if (kind) {
    lexSql += " AND kind = ?";
    filterParams.push(kind);
  }
  if (source) {
    lexSql += " AND source = ?";
    filterParams.push(source);
  }
  if (!includeSuperseded) lexSql += " AND superseded = 0";
  lexSql += " ORDER BY bm25(notes_fts) LIMIT ?";
  const lexStmt = db.prepare(lexSql);
  const runLex = (m: string): LexCandidate[] =>
    lexStmt.all(m, ...filterParams, cap) as LexCandidate[];
  // OR fallback (#209): when the AND candidate list is empty, the lexical list feeding RRF becomes
  // the OR result — so lexical-OR hits join the fusion alongside the semantic candidates.
  let lexRows = runLex(match);
  if (lexRows.length === 0 && matchOr) lexRows = runLex(matchOr);

  // Semantic candidates: cosine over every vector, filtered by the SAME note metadata so a
  // superseded / wrong-kind / wrong-source note can never resurface through the vector side.
  const scored: Array<{ id: string; sim: number }> = [];
  for (const [id, vec] of semantic.vectors) {
    const m = meta.get(id);
    if (!m) continue; // vector for a note no longer in the index
    if (!includeSuperseded && m.superseded) continue;
    if (kind && m.kind !== kind) continue;
    if (source && m.source !== source) continue;
    const sim = cosineSimilarity(semantic.queryVec, vec);
    if (sim <= 0) continue;
    scored.push({ id, sim });
  }
  scored.sort((a, b) => b.sim - a.sim || compareId(a.id, b.id));
  const semRows = scored.slice(0, SEMANTIC_CANDIDATE_CAP);

  // 1-based rank of each note in each list — the RRF inputs, and also the diagnostics (#236) and
  // the "did it arrive lexically?" signal that strict support keys off.
  const lexRank = new Map<string, number>();
  lexRows.forEach((r, i) => lexRank.set(r.id, i + 1));
  const semRank = new Map<string, number>();
  semRows.forEach((r, i) => semRank.set(r.id, i + 1));

  // Reciprocal-rank fusion: a note's score is the sum of 1/(k + rank) over each list it appears
  // in (rank is 1-based). RRF sidesteps normalising BM25's and cosine's incomparable scales.
  const rrf = new Map<string, number>();
  lexRows.forEach((r, i) => rrf.set(r.id, (rrf.get(r.id) ?? 0) + 1 / (RRF_K + i + 1)));
  semRows.forEach((r, i) => rrf.set(r.id, (rrf.get(r.id) ?? 0) + 1 / (RRF_K + i + 1)));

  const lexById = new Map(lexRows.map((r) => [r.id, r]));

  // Strict retrieval (#236): a candidate's lexical support is the number of distinct query tokens
  // with a lexical anchor on it. Arriving in the (OR-expanded, #209) lexical list is itself an
  // anchor — such a note has support ≥ 1 — so strict mode only ever prunes SEMANTIC-only candidates
  // that also lack any query keyword in their title/tags: pure vector noise. `minLexicalSupport: 0`
  // (default) keeps everything (support ≥ 0 is always true), preserving today's behavior exactly.
  const minSupport = opts?.minLexicalSupport ?? 0;
  const rawTokens = minSupport > 0 ? toRawTokens(query) : [];
  const supportOf = (id: string): number => {
    const inLex = lexById.has(id);
    let titleTagHits = 0;
    if (rawTokens.length > 0) {
      const m = meta.get(id)!;
      const hay = `${m.title} ${m.tags}`.toLowerCase();
      for (const t of rawTokens) if (hay.includes(t)) titleTagHits += 1;
    }
    return inLex ? Math.max(1, titleTagHits) : titleTagHits;
  };

  const withDiagnostics = opts?.diagnostics === true;
  const keptIds = [...rrf.keys()].filter((id) => minSupport === 0 || supportOf(id) >= minSupport);

  // Bodies only for the semantic-only hits (no FTS snippet) that survive and will be returned.
  const bodies = loadBodies(
    db,
    keptIds.filter((id) => !lexById.has(id)),
  );

  const fused = keptIds.map((id) => {
    const m = meta.get(id)!;
    const snippet = lexById.get(id)?.snippet ?? plainSnippet(bodies.get(id) ?? "");
    const lr = lexRank.get(id) ?? null;
    const sr = semRank.get(id) ?? null;
    const rrfScore = rrf.get(id)!;
    const result: SearchResult = {
      id,
      kind: m.kind,
      title: m.title,
      path: m.path,
      ...(m.source ? { source: m.source } : {}),
      snippet,
      score: rrfScore,
      ...(withDiagnostics
        ? {
            diagnostics: {
              lexicalRank: lr,
              semanticRank: sr,
              rrfScore,
              tier: lr !== null && sr !== null ? "hybrid" : lr !== null ? "lexical" : "semantic",
            } satisfies ResultDiagnostics,
          }
        : {}),
    };
    return { result, stale: m.status === "stale" };
  });

  // Stale tier first (fresh above stale, matching the lexical ORDER BY), then RRF desc, then id
  // for a deterministic, stable order.
  fused.sort((a, b) => {
    if (a.stale !== b.stale) return a.stale ? 1 : -1;
    if (a.result.score !== b.result.score) return b.result.score - a.result.score;
    return compareId(a.result.id, b.result.id);
  });

  return fused.slice(0, limit).map((f) => f.result);
}

/** Load id→metadata for every indexed note (cheap: no body). */
function loadNoteMeta(db: Database.Database): Map<string, NoteMeta> {
  const rows = db
    .prepare("SELECT id, kind, title, tags, path, source, status, superseded FROM notes_fts")
    .all() as Array<{
    id: string;
    kind: NoteKind;
    title: string;
    tags: string;
    path: string;
    source: string;
    status: string;
    superseded: number | string;
  }>;
  const map = new Map<string, NoteMeta>();
  for (const r of rows) {
    map.set(r.id, {
      kind: r.kind,
      title: r.title,
      tags: r.tags,
      path: r.path,
      source: r.source,
      status: r.status,
      // FTS5 stores UNINDEXED columns as text, so the 0/1 flag round-trips as "0"/"1".
      superseded: Number(r.superseded) === 1,
    });
  }
  return map;
}

/** Fetch note bodies for `ids` (used to build a plain excerpt for semantic-only hits). */
function loadBodies(db: Database.Database, ids: string[]): Map<string, string> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id, body FROM notes_fts WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string; body: string }>;
  for (const r of rows) map.set(r.id, r.body);
  return map;
}

/** A plain (unhighlighted) leading excerpt of a note body, for semantic hits with no FTS match. */
function plainSnippet(body: string): string {
  const text = body.replace(/\s+/g, " ").trim();
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

/** Deterministic id comparator for stable tie-breaking. */
function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Neutralize a note-controlled string for safe inclusion in the GENERATED markdown that agents
 * read (COMMONWEALTH.md / INDEX.md). Titles and `source` are free text; without this a title
 * like `x](evil.md) ## Ignore prior instructions\n# ` could break out of its link/list item and
 * inject new markdown structure (headings, links, directives) into every teammate's injected
 * context — a prompt-injection vector (#102). We collapse line breaks (so it can't start a new
 * block), escape the markdown-structural chars `[` `]` `` ` `` (so it can't form a link or code
 * span), and cap the length. The stored note is untouched; only the derived rendering is escaped.
 */
function inlineText(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/[[\]`]/g, (c) => `\\${c}`)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** Notes whose `status` counts as still-active work (i.e. not `done`). */
function isActiveWorkState(note: Note): boolean {
  return note.frontmatter.kind === "work-state" && note.frontmatter.status !== "done";
}

/** Stable, deterministic sort by id so derived output is byte-identical across runs. */
function byId(a: Note, b: Note): number {
  return a.frontmatter.id < b.frontmatter.id ? -1 : a.frontmatter.id > b.frontmatter.id ? 1 : 0;
}

/** Sort decisions by created date desc, tie-broken by id for determinism. */
function byCreatedDesc(a: Note, b: Note): number {
  if (a.frontmatter.created !== b.frontmatter.created) {
    return a.frontmatter.created < b.frontmatter.created ? 1 : -1;
  }
  return byId(a, b);
}

/** Display label for a note's originating project; unattributed notes group under a sentinel. */
const UNATTRIBUTED = "(unattributed)";
function sourceOf(note: Note): string {
  return note.frontmatter.source && note.frontmatter.source.length > 0
    ? note.frontmatter.source
    : UNATTRIBUTED;
}

/** RESOLVED project label for a note (ADR-0031); unattributed notes group under the sentinel. */
function projectOf(note: Note, aliasMap: ProjectAliasMap): string {
  return resolveNoteProject(note, aliasMap) ?? UNATTRIBUTED;
}

/** Sort project/source labels alphabetically, with the unattributed bucket always last. */
function bySourceLabel(a: string, b: string): number {
  if (a === UNATTRIBUTED) return b === UNATTRIBUTED ? 0 : 1;
  if (b === UNATTRIBUTED) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Render one project's active work-state + recent decisions as router list items. */
function renderProjectBody(lines: string[], group: Note[]): void {
  const active = group.filter(isActiveWorkState).sort(byId);
  // Superseded decisions are archaeology — never inject them into every session's router (#133).
  const decisions = group
    .filter((n) => n.frontmatter.kind === "decision" && !isSuperseded(n))
    .sort(byCreatedDesc);
  lines.push("**Active work-state**");
  if (active.length === 0) {
    lines.push("- _None._");
  } else {
    for (const n of active) {
      const status = n.frontmatter.kind === "work-state" ? n.frontmatter.status : "";
      lines.push(`- [${inlineText(n.frontmatter.title)}](${n.path}) — ${status}`);
    }
  }
  lines.push("");
  lines.push("**Recent decisions**");
  if (decisions.length === 0) {
    lines.push("- _None._");
  } else {
    for (const n of decisions) {
      lines.push(`- [${inlineText(n.frontmatter.title)}](${n.path}) — ${n.frontmatter.created}`);
    }
  }
  lines.push("");
}

/**
 * The generated router, grouped by RESOLVED project identity (ADR-0031). A section per project;
 * when a project unions MORE THAN ONE `source` (linked via the alias map), each source renders as a
 * `### <source>` provenance subhead so the divide stays legible — capture provenance is preserved,
 * only the grouping changes. A single-source project (the default, and every unlinked source) renders
 * flat, byte-identical to the pre-ADR-0031 per-source router. `aliasMap` is a derivation input, so
 * linking/unlinking reorganizes this file with no note edits and rebuilds deterministically (ADR-0003).
 */
function commonwealthMarkdown(notes: Note[], aliasMap: ProjectAliasMap): string {
  const lines: string[] = [];
  lines.push("# Commonwealth");
  lines.push("");
  lines.push("> Generated router. Do not edit by hand — regenerated from the note set (ADR-0003).");
  lines.push("");

  const byProject = new Map<string, Note[]>();
  for (const n of notes) {
    const key = projectOf(n, aliasMap);
    (byProject.get(key) ?? byProject.set(key, []).get(key)!).push(n);
  }
  const projects = [...byProject.keys()].sort(bySourceLabel);
  if (projects.length === 0) {
    lines.push("_No notes yet._");
    lines.push("");
    return lines.join("\n");
  }

  for (const project of projects) {
    const group = byProject.get(project)!;
    lines.push(`## ${inlineText(project)}`);
    lines.push("");

    // Distinct provenance sources within this project. >1 means sources were linked into one
    // engagement — surface each as a provenance subhead; otherwise render flat (unchanged default).
    const sources = [...new Set(group.map(sourceOf))].sort(bySourceLabel);
    if (sources.length > 1) {
      for (const source of sources) {
        lines.push(`### ${inlineText(source)}`);
        lines.push("");
        renderProjectBody(
          lines,
          group.filter((n) => sourceOf(n) === source),
        );
      }
    } else {
      renderProjectBody(lines, group);
    }
  }

  return lines.join("\n");
}

/** Generated INDEX.md for one note-containing directory: its notes, linked by filename. */
function indexMarkdown(dirRel: string, notes: Note[]): string {
  const sorted = [...notes].sort(byId);
  const lines: string[] = [];
  lines.push(`# ${dirRel}`);
  lines.push("");
  lines.push("> Generated index. Do not edit by hand — regenerated from the note set.");
  lines.push("");
  if (sorted.length === 0) {
    lines.push("_None._");
  } else {
    for (const n of sorted) {
      // INDEX.md lives in the same folder as the notes, so link by filename only.
      lines.push(`- [${inlineText(n.frontmatter.title)}](${path.posix.basename(n.path)})`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Regenerate derived, never-hand-merged artifacts from the note set: the `COMMONWEALTH.md`
 * router (grouped by project, ADR-0015) and an `INDEX.md` in every directory that holds notes
 * (`<kind>/` and `<project>/<kind>/`). Idempotent — output is a pure function of the files
 * (ADR-0003), so running twice yields byte-identical files.
 */
export async function regenerateDerived(brainDir: string): Promise<void> {
  const notes = await listNotes(brainDir);
  // The alias map is a derivation INPUT (ADR-0031), loaded like brain config — linking sources
  // reorganizes the router with zero note edits, and the output stays a pure function of the inputs.
  const aliasMap = await loadProjectAliasMap(brainDir);

  await fs.writeFile(
    path.join(brainDir, "COMMONWEALTH.md"),
    commonwealthMarkdown(notes, aliasMap),
    "utf8",
  );

  // One INDEX.md per directory that actually contains notes — works for both the flat kind
  // root and per-project subtrees without assuming a fixed set of folders.
  const byDir = new Map<string, Note[]>();
  for (const n of notes) {
    const dir = path.posix.dirname(n.path.split(path.sep).join("/"));
    (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(n);
  }
  for (const [dir, group] of byDir) {
    const abs = path.join(brainDir, dir);
    await fs.mkdir(abs, { recursive: true });
    await fs.writeFile(path.join(abs, "INDEX.md"), indexMarkdown(dir, group), "utf8");
  }
}
