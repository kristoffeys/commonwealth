import { createInterface } from "node:readline/promises";

/**
 * A minimal interactive prompter over a terminal. {@link createReadlinePrompter} wires this to
 * `node:readline/promises`; the wizard depends only on this interface so tests can drive it with a
 * scripted fake and never touch a real TTY.
 */
export interface Prompter {
  /** Ask for free text; show `message [def]: `; empty input returns `def`. */
  text(message: string, def: string): Promise<string>;
  /** Ask a yes/no question defaulting to `def`; empty input returns `def`. */
  confirm(message: string, def: boolean): Promise<boolean>;
  /** Release the underlying readline interface (idempotent). */
  close(): void;
}

/**
 * True only when BOTH stdin and stdout are TTYs — the precondition for interactive prompting.
 * Non-TTY (piped/CI) callers must fall back to defaults + flags and never block on stdin.
 */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Parse a yes/no answer. Recognizes `y`/`yes`/`n`/`no` case-insensitively (trimmed); empty input
 * returns `def`; anything else also falls back to `def` (a lenient default-accept). Pure, so it is
 * unit-testable without a TTY.
 *
 * @param input Raw line the user typed.
 * @param def The default applied to empty (or unrecognized) input.
 * @returns The resolved boolean answer.
 */
export function parseConfirm(input: string, def: boolean): boolean {
  const v = input.trim().toLowerCase();
  if (v === "") return def;
  if (v === "y" || v === "yes") return true;
  if (v === "n" || v === "no") return false;
  return def;
}

/**
 * Resolve a free-text answer against its default: empty (trimmed) input returns `def`, otherwise
 * the trimmed input. Pure counterpart to {@link Prompter.text} for unit tests.
 *
 * @param input Raw line the user typed.
 * @param def The default applied to empty input.
 * @returns The resolved text answer.
 */
export function parseText(input: string, def: string): string {
  const v = input.trim();
  return v === "" ? def : v;
}

/** Render the `[Y/n]` / `[y/N]` hint reflecting the default. */
function confirmHint(def: boolean): string {
  return def ? "[Y/n]" : "[y/N]";
}

/**
 * A real {@link Prompter} backed by `node:readline/promises` over stdin/stdout. Only construct this
 * after {@link isInteractive} returns true; on a non-TTY it would block waiting for input.
 *
 * @returns A prompter whose `close()` ends the readline interface.
 */
export function createReadlinePrompter(): Prompter {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;

  return {
    async text(message: string, def: string): Promise<string> {
      const answer = await rl.question(`${message} [${def}]: `);
      return parseText(answer, def);
    },
    async confirm(message: string, def: boolean): Promise<boolean> {
      const answer = await rl.question(`${message} ${confirmHint(def)}: `);
      return parseConfirm(answer, def);
    },
    close(): void {
      if (closed) return;
      closed = true;
      rl.close();
    },
  };
}
