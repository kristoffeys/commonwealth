import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { findSecretsForBrain, loadBrainConfig } from "@cmnwlth/core";
import { forcePush, openRepo } from "./git.js";

/**
 * History-purging secret redaction (#271). The pre-commit scrub (`scrubStagedSecrets`) only stops a
 * secret entering a NEW commit — it does nothing about a credential that already landed in a PRIOR
 * commit's blob. The motivating leak: a note carries `AKIA…`, a later commit "redacts" it to a
 * placeholder in the WORKING TREE, and everyone assumes it's gone — but `git log -p` (and any clone)
 * still recovers the raw value from the old blob. Rotating the credential is the real fix, but until
 * the history is rewritten the live value is still sitting in the shared remote.
 *
 * `redactHistory` is the explicit, destructive remediation for that: it scans EVERY blob in ALL of
 * history (not just the working tree), rewrites every occurrence of each leaked literal to the same
 * `[REDACTED:<kind>]` placeholder the working-tree redactor uses, and force-pushes the rewritten
 * history so the shared remote is scrubbed too. It is deliberately never wired into the background
 * sync daemon (ADR-0037): a force-push that resets every teammate's clone is a human-in-the-loop
 * remediation, not something a daemon does behind your back.
 *
 * Security discipline throughout: the RAW secret is NEVER logged, printed, or placed on a command
 * line / in an env var (only masked previews + kinds + counts are surfaced). The one place a raw
 * literal touches disk is the replace-text spec file, which is created 0600 in a private temp dir
 * and unlinked in a `finally`.
 */

/** Which history-rewrite engine drives the purge. */
export type RedactEngine = "filter-repo" | "filter-branch";

/** Terminal state of a {@link redactHistory} run. */
export type RedactStatus = "clean" | "dry-run" | "aborted" | "rewritten";

export interface RedactHistoryOptions {
  /** Discover + report what would be purged, then stop — no rewrite, no push. */
  dryRun?: boolean;
  /** Skip the interactive "type the brain name" confirmation (for scripts/CI/tests). */
  yes?: boolean;
  /** Force a specific engine. Default: prefer filter-repo when installed, else filter-branch. */
  engine?: RedactEngine;
  /**
   * Sink for human-readable progress/impact lines. Defaults to `console.error`. Injected by tests so
   * they can assert the raw secret is never emitted — only masked previews reach this.
   */
  log?: (line: string) => void;
  /**
   * Confirmation reader used when neither `yes` nor `dryRun` is set: it is handed the prompt text and
   * must resolve to the line the user typed. Defaults to a one-shot stdin readline. Injected by tests.
   */
  confirm?: (prompt: string) => Promise<string>;
}

export interface RedactHistoryResult {
  status: RedactStatus;
  /** Distinct leaked literals rewritten (or that would be, for dry-run). */
  secretsPurged: number;
  /** Distinct commits whose content carried a literal (rewritten, or that would be). */
  commitsRewritten: number;
  /** Whether the rewritten history was force-pushed to `origin`. */
  pushed: boolean;
  /** The engine that ran (resolved even for `clean`/`dry-run`, so callers can report it). */
  engine: RedactEngine;
}

/** Max bytes of git text output we accept from a single command (rev-list/log on large histories). */
const GIT_TEXT_MAXBUFFER = 512 * 1024 * 1024;

/** Run `git <args>` in `dir`, resolving trimmed stdout; rejects (with stderr) on non-zero exit. */
function runGitText(
  dir: string,
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: dir,
        maxBuffer: GIT_TEXT_MAXBUFFER,
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`git ${args[0] ?? ""} failed: ${String(stderr).trim() || err.message}`));
          return;
        }
        resolve(stdout.toString().trim());
      },
    );
  });
}

/**
 * Run `git <args>` in `dir` and resolve its stdout as a single Buffer, streaming chunks so we never
 * trip a fixed `maxBuffer` cap on a big object database. Used for the `cat-file --batch` sweep, whose
 * output is binary blob content.
 */
function spawnGitBuffer(dir: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: dir });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => errChunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(`git ${args[0] ?? ""} failed: ${Buffer.concat(errChunks).toString().trim()}`),
        );
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

/** One leaked secret: its raw literal is the map KEY; the value never carries it. */
interface DiscoveredSecret {
  kind: string;
  /** Masked preview (first4 + "..." + last2) — the only form that is ever surfaced. */
  preview: string;
}

interface Discovery {
  /** literal secret string -> {kind, preview}. De-duplicated across every blob in history. */
  secrets: Map<string, DiscoveredSecret>;
  /** Blob object ids that carry at least one literal (used to count affected commits). */
  taintedBlobs: Set<string>;
}

/**
 * Scan EVERY blob in the whole object database for secrets (#271). `git cat-file --batch
 * --batch-all-objects` streams every object as `<sha> <type> <size>\n<raw bytes>\n`; we skip
 * non-blob objects by type and skip binary blobs (a NUL byte), then run the same brain-configured
 * detector the write-gates use over each blob's text. The RAW literal is recovered exactly the way
 * every other call site recovers it — `text.slice(index, index + length)` — and used only as a map
 * key; only the masked preview is retained for display.
 */
async function discoverSecrets(dir: string): Promise<Discovery> {
  const config = await loadBrainConfig(dir);
  const buf = await spawnGitBuffer(dir, [
    "cat-file",
    "--batch",
    "--batch-all-objects",
    "--unordered",
  ]);

  const secrets = new Map<string, DiscoveredSecret>();
  const taintedBlobs = new Set<string>();

  let offset = 0;
  while (offset < buf.length) {
    const nl = buf.indexOf(0x0a, offset);
    if (nl === -1) break;
    const header = buf.toString("utf8", offset, nl);
    const parts = header.split(" ");
    // A well-formed record is "<sha> <type> <size>"; "<sha> missing" (shouldn't happen for
    // --batch-all-objects) has no body — advance past the header line and continue.
    if (parts.length < 3) {
      offset = nl + 1;
      continue;
    }
    const [sha, type, sizeStr] = parts;
    const size = Number.parseInt(sizeStr!, 10);
    const contentStart = nl + 1;
    const contentEnd = contentStart + (Number.isFinite(size) ? size : 0);
    const content = buf.subarray(contentStart, contentEnd);
    // Advance past the body and its trailing LF for the next record.
    offset = contentEnd + 1;

    if (type !== "blob") continue;
    if (content.includes(0)) continue; // binary blob — not scannable text

    const text = content.toString("utf8");
    const matches = findSecretsForBrain(text, config);
    if (matches.length === 0) continue;
    taintedBlobs.add(sha!);
    for (const m of matches) {
      const literal = text.slice(m.index, m.index + m.length);
      if (literal.length === 0) continue;
      if (!secrets.has(literal)) secrets.set(literal, { kind: m.kind, preview: m.preview });
    }
  }

  return { secrets, taintedBlobs };
}

/**
 * Count distinct commits whose content carried any tainted blob. `git log --all --raw` lists, per
 * commit, the pre- and post-image blob ids of every changed path — so a blob that was introduced in
 * one commit and replaced in the next is attributed to BOTH (as a post-image, then a pre-image),
 * which is exactly the leaked-then-"redacted" shape we care about. The output is only object ids and
 * paths — never file content — so this is safe to run without leaking a secret.
 */
async function countCommitsCarrying(dir: string, taintedBlobs: Set<string>): Promise<number> {
  if (taintedBlobs.size === 0) return 0;
  const out = await runGitText(dir, [
    "log",
    "--all",
    "--root",
    "--raw",
    "--no-abbrev", // emit FULL 40-hex blob ids; taintedBlobs holds full ids, abbreviated won't match
    "--no-renames",
    "--format=%H",
  ]);
  const carrying = new Set<string>();
  let current: string | null = null;
  for (const line of out.split("\n")) {
    if (/^[0-9a-f]{40}$/.test(line)) {
      current = line;
      continue;
    }
    if (!line.startsWith(":") || current === null) continue;
    const tab = line.indexOf("\t");
    const meta = (tab === -1 ? line : line.slice(0, tab)).slice(1); // drop leading ':'
    const tok = meta.split(/\s+/);
    // ":<mode1> <mode2> <presha> <postsha> <status>" → presha=tok[2], postsha=tok[3]
    const pre = tok[2];
    const post = tok[3];
    if ((pre && taintedBlobs.has(pre)) || (post && taintedBlobs.has(post))) carrying.add(current);
  }
  return carrying.size;
}

/** True when `git filter-repo` is installed and runnable. */
async function filterRepoAvailable(dir: string): Promise<boolean> {
  try {
    await runGitText(dir, ["filter-repo", "--version"]);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the engine to use, honoring an explicit request and falling back when filter-repo is absent. */
async function resolveEngine(
  dir: string,
  requested: RedactEngine | undefined,
): Promise<RedactEngine> {
  if (requested === "filter-branch") return "filter-branch";
  const haveFilterRepo = await filterRepoAvailable(dir);
  if (requested === "filter-repo") {
    if (!haveFilterRepo) {
      throw new Error(
        "git filter-repo was requested but is not installed. Install it " +
          "(https://github.com/newren/git-filter-repo) or pass --engine filter-branch.",
      );
    }
    return "filter-repo";
  }
  return haveFilterRepo ? "filter-repo" : "filter-branch";
}

/** Origin's fetch (or push) URL, or null when there is no `origin` remote. */
async function originUrl(dir: string): Promise<string | null> {
  const remotes = await openRepo(dir).getRemotes(true);
  const origin = remotes.find((r) => r.name === "origin");
  return origin?.refs?.fetch || origin?.refs?.push || null;
}

/**
 * The Node tree-filter helper shipped for the filter-branch fallback. It is written to a temp file at
 * runtime (see {@link runFilterBranch}) rather than shipped as a raw `.mjs` next to the source,
 * because tsup only bundles the package entrypoint — a sibling `.mjs` would not survive into `dist`,
 * so resolving it via `import.meta.url` from the built bundle would fail. Generating it at runtime is
 * self-contained and dist-safe.
 *
 * It reads the replace-text spec path from `$COMMONWEALTH_REDACT_SPEC`, parses each
 * `literal:<from>==>[REDACTED:<kind>]` line, and does a literal `replaceAll` over every text file in
 * the checked-out tree (its cwd) — NEVER `sed` over secret bytes. Binary files (a NUL byte) are
 * skipped, as is the `.git` directory.
 */
const TREE_FILTER_HELPER = `import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const specPath = process.env.COMMONWEALTH_REDACT_SPEC;
if (!specPath) process.exit(0);

const repls = [];
for (const line of readFileSync(specPath, "utf8").split("\\n")) {
  if (!line.startsWith("literal:")) continue;
  const body = line.slice("literal:".length);
  const sep = body.indexOf("==>");
  if (sep === -1) continue;
  const from = body.slice(0, sep);
  const to = body.slice(sep + 3);
  if (from.length > 0) repls.push([from, to]);
}
if (repls.length === 0) process.exit(0);

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === ".git") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (!st.isFile()) continue;
    const buf = readFileSync(p);
    if (buf.includes(0)) continue; // binary
    let text = buf.toString("utf8");
    let changed = false;
    for (const [from, to] of repls) {
      if (text.includes(from)) { text = text.replaceAll(from, to); changed = true; }
    }
    if (changed) writeFileSync(p, text);
  }
}
walk(process.cwd());
`;

/**
 * Run the filter-repo purge: `git filter-repo --replace-text <spec> --force`. filter-repo REMOVES the
 * `origin` remote after rewriting (the caller re-adds it from the URL captured beforehand) and
 * refuses to run on a non-fresh clone without `--force`, hence both are handled here.
 */
async function runFilterRepo(dir: string, specPath: string): Promise<void> {
  await runGitText(dir, ["filter-repo", "--replace-text", specPath, "--force"]);
}

/**
 * Run the filter-branch fallback: a `--tree-filter` that invokes the generated Node helper over every
 * commit's checked-out tree, with the spec path passed via env (never on the command line). Afterward
 * it deletes the `refs/original/*` backups, expires the reflog, and prunes so the pre-rewrite blobs
 * are actually gone from the local object store.
 */
async function runFilterBranch(dir: string, specPath: string): Promise<void> {
  const helperPath = path.join(path.dirname(specPath), "redact-tree-filter.mjs");
  await fs.writeFile(helperPath, TREE_FILTER_HELPER, { mode: 0o600 });

  // The tree-filter is a shell snippet filter-branch evals per commit; the spec path rides in via env
  // so the raw secrets (in the spec file) never appear in any argv. FILTER_BRANCH_SQUELCH_WARNING
  // silences filter-branch's interactive "this is dangerous" nag on a non-TTY.
  await runGitText(
    dir,
    ["filter-branch", "--force", "--tree-filter", `node '${helperPath}'`, "--", "--all"],
    { FILTER_BRANCH_SQUELCH_WARNING: "1", COMMONWEALTH_REDACT_SPEC: specPath },
  );

  // Drop the pre-rewrite backup refs, then expire + gc so old blobs are unreachable AND collected.
  const originalRefs = await runGitText(dir, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/original/",
  ]);
  for (const ref of originalRefs.split("\n").filter((l) => l.length > 0)) {
    await runGitText(dir, ["update-ref", "-d", ref]);
  }
  await runGitText(dir, ["reflog", "expire", "--expire=now", "--all"]);
  await runGitText(dir, ["gc", "--prune=now"]);
}

/** Default confirmation: read one line from stdin, prompting on stderr. */
function defaultConfirm(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Purge every leaked credential from a brain's entire git history and (when a remote exists)
 * force-push the rewritten history to scrub the shared remote (#271, ADR-0037).
 *
 * Stages: precondition check (clean tree, resolvable branch) → resolve engine → discover secrets
 * across ALL blobs → confirm (unless `yes`/`dryRun`) → rewrite with filter-repo (or the filter-branch
 * fallback) → force-push → print teammate recovery. Returns a summary; the raw secret is never
 * surfaced anywhere in output or the return value.
 */
export async function redactHistory(
  dir: string,
  opts: RedactHistoryOptions = {},
): Promise<RedactHistoryResult> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const confirmFn = opts.confirm ?? defaultConfirm;
  const git = openRepo(dir);

  // --- Preconditions -------------------------------------------------------------------------
  // A dirty tree means uncommitted work that a rewrite could strand or that hides which blobs are in
  // play; the user should land or discard it (and redact the working copy) first.
  const status = await git.status();
  if (!status.isClean()) {
    throw new Error(
      "working tree is not clean — commit, stash, or discard changes first (and redact the " +
        "working copy) before rewriting history.",
    );
  }
  // NB: simple-git reports `current === "HEAD"` (truthy) on a detached HEAD, so `!current` never
  // fires there — key off `status.detached`, which IS true, so we abort BEFORE any rewrite/push
  // rather than rewriting local history and then failing on `push --force origin HEAD`.
  const branch = status.current;
  if (status.detached || !branch) {
    throw new Error(
      "could not resolve the current branch (detached HEAD?) — checkout a branch first.",
    );
  }

  const engine = await resolveEngine(dir, opts.engine);

  // --- Discovery across ALL history ----------------------------------------------------------
  const { secrets, taintedBlobs } = await discoverSecrets(dir);
  if (secrets.size === 0) {
    log("[commonwealth] redact-history: no secrets found anywhere in history — nothing to purge.");
    return { status: "clean", secretsPurged: 0, commitsRewritten: 0, pushed: false, engine };
  }
  const commitsAffected = await countCommitsCarrying(dir, taintedBlobs);
  const remoteUrl = await originUrl(dir);

  // --- Impact summary (masked previews + kinds + counts ONLY) --------------------------------
  const sPlural = secrets.size === 1 ? "" : "s";
  const cPlural = commitsAffected === 1 ? "" : "s";
  log(
    `[commonwealth] redact-history: found ${secrets.size} distinct secret${sPlural} across ` +
      `${commitsAffected} commit${cPlural} in the full history of ${path.basename(path.resolve(dir))}.`,
  );
  for (const { kind, preview } of secrets.values()) log(`  - ${preview}  (${kind})`);
  log(
    remoteUrl
      ? "[commonwealth] a remote is present — rewritten history will be FORCE-PUSHED; every teammate " +
          "will need to reset their clone (recovery steps printed after the rewrite)."
      : "[commonwealth] no remote configured — history will be rewritten locally only.",
  );
  log(
    "[commonwealth] NOTE: rewriting history does not un-leak an exposed credential — rotate/revoke " +
      "the affected secrets regardless.",
  );

  if (opts.dryRun) {
    log("[commonwealth] --dry-run: no history was rewritten and nothing was pushed.");
    return {
      status: "dry-run",
      secretsPurged: secrets.size,
      commitsRewritten: commitsAffected,
      pushed: false,
      engine,
    };
  }

  // --- Confirm -------------------------------------------------------------------------------
  if (!opts.yes) {
    const name = path.basename(path.resolve(dir));
    const answer = await confirmFn(
      `This rewrites shared history and force-pushes. Type the brain name "${name}" to proceed: `,
    );
    if (answer.trim() !== name) {
      log("[commonwealth] redact-history: confirmation did not match — aborted, nothing changed.");
      return {
        status: "aborted",
        secretsPurged: secrets.size,
        commitsRewritten: commitsAffected,
        pushed: false,
        engine,
      };
    }
  }

  // --- Rewrite -------------------------------------------------------------------------------
  // Build the replace-text spec (one `literal:<secret>==>[REDACTED:<kind>]` line per secret) into a
  // 0600 file inside a private temp dir. This is the ONLY place a raw literal touches disk; the whole
  // dir is removed in the `finally`. A literal that itself contains the "==>" separator or a newline
  // can't be expressed line-by-line unambiguously — skip it and flag it for manual removal.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-redact-"));
  const specPath = path.join(tmpDir, "replace.txt");
  try {
    const specLines: string[] = [];
    let skipped = 0;
    for (const [literal, { kind }] of secrets) {
      if (literal.includes("==>") || literal.includes("\n")) {
        skipped += 1;
        continue;
      }
      specLines.push(`literal:${literal}==>[REDACTED:${kind}]`);
    }
    if (skipped > 0) {
      log(
        `[commonwealth] WARNING: ${skipped} secret(s) could not be auto-purged (they contain an ` +
          "unsupported delimiter) — remove those from history manually.",
      );
    }
    if (specLines.length === 0) {
      throw new Error("no secret could be expressed for rewriting — aborting without changes.");
    }
    await fs.writeFile(specPath, `${specLines.join("\n")}\n`, { mode: 0o600 });

    if (engine === "filter-repo") {
      await runFilterRepo(dir, specPath);
    } else {
      await runFilterBranch(dir, specPath);
    }
  } finally {
    // Always shred the transient raw-secret spec (and the generated helper) from disk.
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  // --- Force-push + recovery -----------------------------------------------------------------
  let pushed = false;
  if (remoteUrl) {
    // filter-repo drops the origin remote after rewriting; re-add it from the captured URL.
    const remotesNow = await openRepo(dir).getRemotes();
    if (!remotesNow.some((r) => r.name === "origin")) {
      await runGitText(dir, ["remote", "add", "origin", remoteUrl]);
    }
    const hasTags = (await runGitText(dir, ["tag"])).length > 0;
    await forcePush(dir, branch, { tags: hasTags });
    pushed = true;

    log("[commonwealth] rewritten history force-pushed to origin.");
    log("[commonwealth] Teammates must run, in each clone of this brain:");
    log(`    git fetch origin && git reset --hard origin/${branch}`);
    log(
      "[commonwealth] Any unpushed local work in a teammate's clone must be rebased onto the new " +
        `origin/${branch} by hand — a plain reset --hard would discard it.`,
    );
  } else {
    log("[commonwealth] no remote — local history rewritten; nothing to push.");
  }

  return {
    status: "rewritten",
    secretsPurged: secrets.size,
    commitsRewritten: commitsAffected,
    pushed,
    engine,
  };
}
