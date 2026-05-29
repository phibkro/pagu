// pure: the addressable read over the event log (`since`, offset);
// effects: the live `subscribe` notifier (a thin wake-up over the same array).
//
// The conversation log is single-writer append-only (CONTEXT → State model), so
// an event's id is simply its **index** in the log — no uuid/hash needed until
// multi-host (the deferred CRDT edge). This seam is what every non-co-located
// subscriber (a management/observability surface, an alerting webhook, a remote
// ACP client) consumes: ask for everything after offset N, then tail. The
// markdown stays the source-of-truth projection; this is the read side.
import type { Entry } from "./log/schema.ts";

/** An event plus its stable offset (its index in the single-writer log). */
export interface Indexed {
  offset: number;
  entry: Entry;
}

export interface EventStream {
  /** The next offset = the current event count. */
  offset(): number;
  /** Addressable read: every event from `from` onward, with its offset. Pure. */
  since(from: number): Indexed[];
  /** Wake subscribers — called by the writer (persist) after appends. */
  notify(): void;
  /** End all subscriptions (session over). */
  close(): void;
  /** Backlog from `from`, then live events as they are appended, until closed
   * or the signal aborts. */
  subscribe(from: number, signal?: AbortSignal): AsyncIterableIterator<Indexed>;
}

export function eventStream(log: Entry[]): EventStream {
  let waiters: Array<() => void> = [];
  let closed = false;
  // Wake every pending subscriber. Swap the array first so a waiter that
  // re-subscribes in its continuation lands in the next batch, not this one.
  const wake = () => {
    const pending = waiters;
    waiters = [];
    for (const resume of pending) resume();
  };

  return {
    offset: () => log.length,
    since: (from) => {
      const start = Math.max(0, from);
      return log.slice(start).map((entry, i) => ({ offset: start + i, entry }));
    },
    notify: wake,
    close: () => {
      closed = true;
      wake();
    },
    async *subscribe(from, signal) {
      let cursor = Math.max(0, from);
      while (true) {
        // Drain everything appended since we last looked (offset = index).
        while (cursor < log.length) {
          yield { offset: cursor, entry: log[cursor] };
          cursor++;
        }
        if (closed || signal?.aborted) return;
        // Idle: wait for the next notify()/close(), or an abort.
        await new Promise<void>((resume) => {
          waiters.push(resume);
          signal?.addEventListener("abort", () => resume(), { once: true });
        });
      }
    },
  };
}
