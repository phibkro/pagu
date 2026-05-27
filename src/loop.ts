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
