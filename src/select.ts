// effects: terminal list selection; the model (intentOf/reduce/frame) is pure
import { keypress } from "@cliffy/keypress";

const enc = new TextEncoder();
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

/**
 * An interactive list picker (arrow keys / space / enter), the shared widget
 * behind `/roles` and `/open`. Key *decoding* is delegated to `@cliffy/keypress`
 * (it handles the fiddly terminal long tail — SS3 arrows, modifiers — that a
 * hand-rolled byte parser gets wrong); everything pagu-specific stays here and
 * stays pure: `intentOf` (event → our intent), `reduce` (state transition), and
 * `frame` (visible rows), so the logic is unit-testable without a TTY.
 *
 * Crucially we drive keypress at the *event* level rather than using
 * `@cliffy/prompt`'s Select/Checkbox: those call `exit(130)` on Ctrl-C, which
 * would kill the whole REPL. Here Ctrl-C / Esc just cancel the picker (→ null)
 * and the prompt loop continues. A non-TTY stdin also returns null, so callers
 * keep a text fallback.
 */

export type Key = "up" | "down" | "space" | "enter" | "cancel" | "other";

export interface SelectState {
  cursor: number; // highlighted index
  offset: number; // first visible index (top of the viewport)
  marked: Set<number>; // selected indices (multi-select only)
}

/** Map a keypress event to an intent. Ctrl-C/Ctrl-D and Esc/q cancel; j/k
 * mirror the arrows. (cliffy names: arrows "up"/"down", "space", "return".) */
export function intentOf(ev: { key?: string; ctrlKey?: boolean }): Key {
  if (ev.ctrlKey) return ev.key === "c" || ev.key === "d" ? "cancel" : "other";
  switch (ev.key) {
    case "up":
    case "k":
      return "up";
    case "down":
    case "j":
      return "down";
    case "space":
      return "space";
    case "return":
      return "enter";
    case "escape":
    case "q":
      return "cancel";
    default:
      return "other";
  }
}

/** Advance the model by one navigation key (enter/cancel are terminal and
 * handled by the loop, not here). Cursor wraps at the ends; the viewport
 * follows it so the cursor is always visible. Space toggles marks in
 * multi-select; it's a no-op otherwise. */
export function reduce(
  s: SelectState,
  key: Key,
  len: number,
  height: number,
  multi: boolean,
): SelectState {
  if (len === 0) return s;
  let { cursor, offset } = s;
  let marked = s.marked;
  if (key === "up") cursor = (cursor - 1 + len) % len;
  else if (key === "down") cursor = (cursor + 1) % len;
  else if (key === "space" && multi) {
    marked = new Set(marked);
    if (marked.has(cursor)) marked.delete(cursor);
    else marked.add(cursor);
  }
  const h = Math.min(height, len);
  if (cursor < offset) offset = cursor; // scrolled above the window
  if (cursor >= offset + h) offset = cursor - h + 1; // below the window
  return { cursor, offset, marked };
}

/** The visible rows (plain text — coloring is the shell's job), one per
 * viewport line: a cursor marker, an optional checkbox, then the label. */
export function frame(
  s: SelectState,
  labels: string[],
  height: number,
  multi: boolean,
): string[] {
  const h = Math.min(height, labels.length);
  const lines: string[] = [];
  for (let i = s.offset; i < s.offset + h; i++) {
    const cur = i === s.cursor ? "›" : " ";
    const box = multi ? (s.marked.has(i) ? "[x] " : "[ ] ") : "";
    lines.push(`${cur} ${box}${labels[i]}`);
  }
  return lines;
}

const hint = (multi: boolean) =>
  multi
    ? "↑/↓ move · space toggle · enter apply · esc cancel"
    : "↑/↓ move · enter select · esc cancel";

export interface SelectOpts<T> {
  label: (item: T) => string;
  /** Multi-select: space toggles, enter returns the marked set. */
  multi?: boolean;
  /** Initial marks (multi-select). */
  selected?: (item: T) => boolean;
  /** Viewport rows (clamped to the list length). */
  height?: number;
  header?: string;
}

/**
 * Drive the picker. Returns the chosen items (a single-element array for
 * single-select), or null on cancel or when stdin is not a TTY. An empty list
 * returns [] without prompting. keypress restores cooked mode on dispose; we
 * also erase our own draw block, leaving a clean transcript for the caller.
 */
export async function selectFromList<T>(
  items: T[],
  opts: SelectOpts<T>,
): Promise<T[] | null> {
  if (items.length === 0) return [];
  if (!Deno.stdin.isTerminal()) return null; // no keystrokes to drive it
  const multi = opts.multi ?? false;
  const height = opts.height ?? 10;
  const labels = items.map(opts.label);
  const marked = new Set<number>();
  if (multi && opts.selected) {
    items.forEach((t, i) => opts.selected!(t) && marked.add(i));
  }
  let state: SelectState = { cursor: 0, offset: 0, marked };

  const out = (s: string) => Deno.stdout.writeSync(enc.encode(s));
  let drawn = 0; // lines in the current frame, to step back over on redraw
  const render = () => {
    if (drawn > 0) out(`\x1b[${drawn}A`); // back to the top of the frame
    out("\x1b[J"); // clear from here down
    const parts: string[] = [];
    if (opts.header) parts.push(opts.header);
    const cursorRow = state.cursor - state.offset;
    frame(state, labels, height, multi).forEach((ln, i) =>
      parts.push(i === cursorRow ? bold(ln) : dim(ln))
    );
    parts.push(dim(hint(multi)));
    out(parts.join("\n") + "\n");
    drawn = parts.length;
  };

  const keys = keypress();
  try {
    render();
    for await (const ev of keys) {
      const key = intentOf(ev);
      if (key === "cancel") return null;
      if (key === "enter") {
        if (!multi) return [items[state.cursor]];
        return [...state.marked].sort((a, b) => a - b).map((i) => items[i]);
      }
      state = reduce(state, key, items.length, height, multi);
      render();
    }
    return null; // input stream ended
  } finally {
    if (drawn > 0) { // erase the widget; the caller prints the outcome
      out(`\x1b[${drawn}A`);
      out("\x1b[J");
    }
    if (!keys.disposed) keys.dispose(); // restore cooked mode + release stdin
  }
}
