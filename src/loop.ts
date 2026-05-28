// pure: loop combinators over an effectful Step; no I/O of its own.

/** The continue/stop coproduct a turn yields. */
export type Flow = "continue" | "done";

/** An effectful turn over some carrier C. */
export type Step<C> = (c: C) => Promise<Flow>;

/**
 * The bounded fixpoint: run `step` until it yields `done` or `maxTurns`
 * iterations elapse. A completed loop yields `done`. `loop : Step → Step` is
 * closed over the type so a loop is itself a composable turn.
 */
export function loop<C>(step: Step<C>, maxTurns: number): Step<C> {
  return async (c: C): Promise<Flow> => {
    for (let i = 0; i < maxTurns; i++) {
      if (await step(c) === "done") return "done";
    }
    return "done";
  };
}

/**
 * Sequence two steps (Kleisli composition over the Flow coproduct): run `a`;
 * if it halts (`done`), skip `b`; otherwise run `b` and return its flow.
 * Short-circuit on `done` = "a gate refused → don't run the rest."
 */
export function andThen<C>(a: Step<C>, b: Step<C>): Step<C> {
  return async (c: C): Promise<Flow> => (await a(c)) === "done" ? "done" : b(c);
}

/**
 * Compose a list of steps left-to-right with `andThen`: run each in turn,
 * short-circuiting at the first `done`. The identity is an always-`continue`
 * step, so `pipeline([])` is a no-op that continues.
 */
export function pipeline<C>(steps: Step<C>[]): Step<C> {
  const cont: Step<C> = () => Promise.resolve("continue");
  return steps.reduce(andThen, cont);
}

/**
 * The eager-parallel fold of the Flow monoid — the dual of `pipeline`'s
 * lazy-sequential fold. Run every branch concurrently over the same carrier,
 * await all to settle, then combine: `done` if ANY branch is `done`, else
 * `continue`. Shares the `continue` identity with `pipeline` (`fanOut([])` is
 * the always-`continue` step). Unlike `pipeline` it never short-circuits
 * execution — every branch runs (a `Step` has no cancellation token); it
 * short-circuits the *result*, not the *work*.
 *
 * Fail-closed: if any branch throws, `fanOut` rejects with the first rejection
 * (in branch order) — a broken gate blocks, never silently permits.
 *
 * **Contract: branches MUST treat the carrier as read-only.** `fanOut` combines
 * their answers; it does not merge mutations. Concurrent mutation of a shared
 * carrier is a data race — fan out only over read-only carriers (e.g.
 * `Step<ReadonlyExec>`). This module stays carrier-agnostic; the call site
 * guarantees race-freedom by its choice of carrier.
 */
export function fanOut<C>(branches: Step<C>[]): Step<C> {
  return async (c: C): Promise<Flow> => {
    const settled = await Promise.allSettled(branches.map((b) => b(c)));
    const rejected = settled.find((r) => r.status === "rejected");
    if (rejected) throw (rejected as PromiseRejectedResult).reason;
    return settled.some((r) =>
        (r as PromiseFulfilledResult<Flow>).value === "done"
      )
      ? "done"
      : "continue";
  };
}
