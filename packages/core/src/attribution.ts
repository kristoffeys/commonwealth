import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { hasSecrets } from "./secrets.js";
import { pathForNote, slugify } from "./ids.js";
import {
  listNotes,
  NoteIdCollisionError,
  overwriteNote,
  readNote,
  writeNote,
  type NewNoteInput,
} from "./notes.js";
import type { Note } from "./schema.js";

const pexec = promisify(execFile);
const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Trusted local identity attached to notes written on a person's behalf. */
export interface ContributorIdentity {
  name: string;
  email?: string;
  /** Normalized stable key used to make automatic person creation idempotent. */
  key: string;
}

export interface ContributorIdentityOptions {
  env?: NodeJS.ProcessEnv;
  runGit?: (cwd: string, key: "user.name" | "user.email") => Promise<string | null>;
}

export interface AttributedNoteInputs {
  /** Existing or deterministic future contributor-person id written into every candidate. */
  personId: string;
  candidates: NewNoteInput[];
}

function cleanName(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  const hasControlCharacter = [...name].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (name.length === 0 || name.length > 200 || hasControlCharacter) return null;
  return name;
}

function cleanEmail(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320 ? email : undefined;
}

async function defaultRunGit(cwd: string, key: "user.name" | "user.email"): Promise<string | null> {
  try {
    const { stdout } = await pexec("git", ["-C", cwd, "config", "--get", key]);
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the person responsible for a write from trusted local process context. A deliberate
 * Commonwealth override wins, followed by Git's commit identity and the local OS account.
 */
export async function resolveContributorIdentity(
  cwd: string,
  options: ContributorIdentityOptions = {},
): Promise<ContributorIdentity | null> {
  const env = options.env ?? process.env;
  const runGit = options.runGit ?? defaultRunGit;
  const overrideName = cleanName(env.COMMONWEALTH_AUTHOR);
  const envGitName = cleanName(env.GIT_AUTHOR_NAME);
  let name = overrideName ?? envGitName;
  if (!name) name = cleanName((await runGit(cwd, "user.name")) ?? undefined);
  if (!name) {
    let username: string | undefined;
    try {
      username = os.userInfo().username;
    } catch {
      username = undefined;
    }
    name = cleanName(env.USER ?? env.USERNAME ?? username);
  }
  if (!name) return null;

  let email: string | undefined;
  if (overrideName) {
    email = cleanEmail(env.COMMONWEALTH_AUTHOR_EMAIL);
  } else {
    email =
      cleanEmail(env.GIT_AUTHOR_EMAIL) ??
      cleanEmail((await runGit(cwd, "user.email")) ?? undefined) ??
      cleanEmail(env.COMMONWEALTH_AUTHOR_EMAIL);
  }
  if (hasSecrets(`${name}\n${email ?? ""}`)) {
    throw new Error("refusing to use a contributor identity that looks like a secret");
  }
  const key = email
    ? `email-sha256:${createHash("sha256").update(email).digest("hex")}`
    : `name:${name.toLowerCase()}`;
  return { name, ...(email ? { email } : {}), key };
}

/** Deterministic contributor-person id; concurrent first writes converge on one atomic file. */
export function contributorPersonId(identity: ContributorIdentity): string {
  const slug = slugify(identity.name) || "contributor";
  const digest = createHash("sha256").update(identity.key).digest("hex").slice(0, 10);
  return `contributor-${slug}-${digest}`;
}

function matchesIdentity(note: Note, identity: ContributorIdentity): boolean {
  if (note.frontmatter.kind !== "person") return false;
  const fm = note.frontmatter;
  if (fm.attribution_key === identity.key) return true;
  return Boolean(identity.email && fm.email?.toLowerCase() === identity.email);
}

function findContributorPerson(people: Note[], identity: ContributorIdentity): Note | undefined {
  const exact = people.find((note) => matchesIdentity(note, identity));
  if (exact) return exact;

  const sameName = people.filter(
    (note) =>
      note.frontmatter.kind === "person" &&
      note.frontmatter.name.trim().toLowerCase() === identity.name.toLowerCase(),
  );
  const existingNameOnly = sameName.filter(
    (note) =>
      note.frontmatter.kind === "person" &&
      !note.frontmatter.email &&
      note.frontmatter.attribution_key?.startsWith("email-sha256:") !== true,
  );
  if (sameName.length === 1 && existingNameOnly.length === 1) return existingNameOnly[0];
  // A name-only write may reuse one unambiguous email-backed person, but never picks arbitrarily
  // when two different people share the display name.
  if (!identity.email && sameName.length === 1) return sameName[0];
  return undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLockOwner(file: string): Promise<number | null> {
  try {
    const pid = Number.parseInt((await fs.readFile(file, "utf8")).trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Atomically move a stale lock aside; only the waiter whose rename wins performs removal. */
async function reclaimStaleLock(lockDir: string): Promise<void> {
  const quarantine = `${lockDir}.stale-${process.pid}-${randomUUID()}`;
  try {
    await fs.rename(lockDir, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await fs.rm(quarantine, { recursive: true, force: true });
}

/** Serialize contributor reservation by normalized display name across processes. */
async function withContributorNameLock<T>(
  brainDir: string,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  const canonicalBrain = await fs.realpath(brainDir).catch(() => path.resolve(brainDir));
  const brainHash = createHash("sha256").update(canonicalBrain).digest("hex").slice(0, 16);
  const nameHash = createHash("sha256").update(name.toLowerCase()).digest("hex").slice(0, 16);
  const lockDir = path.join(os.tmpdir(), "commonwealth-contributor-locks", brainHash, nameHash);
  const ownerFile = path.join(lockDir, "owner");
  await fs.mkdir(path.dirname(lockDir), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await fs.mkdir(lockDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readLockOwner(ownerFile);
      const age = await fs
        .stat(lockDir)
        .then((stat) => Date.now() - stat.mtimeMs)
        .catch(() => 0);
      if ((owner !== null && !processIsAlive(owner)) || (owner === null && age > 30_000)) {
        await reclaimStaleLock(lockDir);
        continue;
      }
      await delay(10);
      continue;
    }
    try {
      await fs.writeFile(ownerFile, `${process.pid}\n`, "utf8");
      return await operation();
    } finally {
      await fs.rm(lockDir, { recursive: true, force: true });
    }
  }
  throw new Error(`timed out reserving contributor identity for ${name}`);
}

/** Ensure exactly one canonical person note exists for the contributor identity. */
export async function ensureContributorPerson(
  brainDir: string,
  identity: ContributorIdentity,
): Promise<Note> {
  return withContributorNameLock(brainDir, identity.name, async () => {
    const people = await listNotes(brainDir, "person");
    const existing = findContributorPerson(people, identity);
    if (existing) {
      const fm = existing.frontmatter;
      const isNameOnly =
        fm.kind === "person" &&
        !fm.email &&
        fm.attribution_key?.startsWith("email-sha256:") !== true;
      if (identity.email && isNameOnly) {
        const upgraded: Note = {
          ...existing,
          frontmatter: { ...fm, attribution_key: identity.key },
        };
        await overwriteNote(brainDir, upgraded);
        return upgraded;
      }
      return existing;
    }

    const id = contributorPersonId(identity);
    try {
      return await writeNote(brainDir, {
        id,
        kind: "person",
        title: identity.name,
        body: "Commonwealth contributor identity used for responsibility attribution.",
        author: identity.name,
        authorRef: id,
        fields: {
          name: identity.name,
          attribution_key: identity.key,
        },
        tags: ["contributor"],
      });
    } catch (error) {
      if (!(error instanceof NoteIdCollisionError)) throw error;
      // Deterministic id + atomic write makes concurrent first use safe: the losing process reads
      // the winner's completed note instead of creating a second person.
      const deterministicPath = pathForNote("person", id);
      const winner = await readNote(brainDir, deterministicPath);
      if (winner.frontmatter.id !== id || !matchesIdentity(winner, identity)) throw error;
      return winner;
    }
  });
}

/**
 * Prepare trusted responsibility provenance without mutating canon. The person is created only
 * after curation accepts at least one candidate, so rejected calls cannot pollute `people/`.
 */
export async function attributeNoteInputs(
  brainDir: string,
  candidates: NewNoteInput[],
  identity: ContributorIdentity,
): Promise<AttributedNoteInputs> {
  const people = await listNotes(brainDir, "person");
  const existing = findContributorPerson(people, identity);
  const personId = existing?.frontmatter.id ?? contributorPersonId(identity);
  const attributed = candidates.map((candidate) => {
    const fields = { ...(candidate.fields ?? {}) };
    const existingRelates = Array.isArray(fields.relates)
      ? fields.relates.filter((value): value is string => typeof value === "string")
      : [];
    fields.relates = [...new Set([...existingRelates, personId])];
    return {
      ...candidate,
      author: identity.name,
      authorRef: personId,
      fields,
    };
  });
  return { personId, candidates: attributed };
}
