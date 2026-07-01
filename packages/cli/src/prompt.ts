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
  /**
   * Numbered multi-select over the given items. Prints each with a `[x]`/`[ ]` marker reflecting
   * `defaultSelected`, then accepts `all` / `none` / a comma-or-space list of 1-based indices;
   * empty input keeps the defaults. Returns the chosen items' `value`s (in item order).
   */
  select(
    message: string,
    items: { label: string; value: string }[],
    defaultSelected: boolean[],
  ): Promise<string[]>;
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

/**
 * Resolve a multi-select answer against a list of candidate values. Pure counterpart to
 * {@link Prompter.select} so tests never touch a TTY. Rules:
 * - empty (trimmed) input keeps `defaultSelected` (values whose flag is true, in order);
 * - `all` selects every value; `none` selects nothing;
 * - otherwise the input is split on commas/whitespace and each token parsed as a 1-based index;
 *   out-of-range or non-numeric tokens are ignored, duplicates collapse, and the result is
 *   returned in `values` order.
 *
 * @param input Raw line the user typed.
 * @param values The candidate values, in display order.
 * @param defaultSelected Per-value default flags (same length/order as `values`).
 * @returns The chosen values, in `values` order.
 */
export function parseSelection(
  input: string,
  values: string[],
  defaultSelected: boolean[],
): string[] {
  const v = input.trim().toLowerCase();
  if (v === "") return values.filter((_, i) => defaultSelected[i]);
  if (v === "all") return [...values];
  if (v === "none") return [];

  const picked = new Set<number>();
  for (const token of v.split(/[\s,]+/).filter((t) => t.length > 0)) {
    const n = Number.parseInt(token, 10);
    if (!Number.isInteger(n)) continue;
    const idx = n - 1; // 1-based input -> 0-based index
    if (idx >= 0 && idx < values.length) picked.add(idx);
  }
  return values.filter((_, i) => picked.has(i));
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
    async select(
      message: string,
      items: { label: string; value: string }[],
      defaultSelected: boolean[],
    ): Promise<string[]> {
      const lines = items.map(
        (item, i) => `  ${i + 1}. [${defaultSelected[i] ? "x" : " "}] ${item.label}`,
      );
      const prompt = `${message}\n${lines.join("\n")}\nSelect (all/none/1,3 — Enter keeps defaults): `;
      const answer = await rl.question(prompt);
      return parseSelection(
        answer,
        items.map((item) => item.value),
        defaultSelected,
      );
    },
    close(): void {
      if (closed) return;
      closed = true;
      rl.close();
    },
  };
}
