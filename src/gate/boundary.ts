// pure: prove operator authority paths are outside sandbox-visible policy roots.
import type { PolicyV0 } from "../policy/index.ts";

export class OperatorBoundaryError extends Error {
  override name = "OperatorBoundaryError";
}

export interface OperatorBoundaryContext {
  readonly home: string;
  readonly pwd: string;
  readonly canonicalize: (path: string) => string | null;
}

export interface OperatorBoundaryPaths {
  readonly policy: string;
  readonly stateDir: string;
  readonly requestSocket: string;
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function expand(path: string, context: OperatorBoundaryContext): string {
  let value = path.endsWith("/**") ? path.slice(0, -3) : path;
  if (value === "$PWD") value = context.pwd;
  else if (value.startsWith("$PWD/")) value = context.pwd + value.slice(4);
  else if (value === "$HOME" || value === "~") value = context.home;
  else if (value.startsWith("$HOME/")) value = context.home + value.slice(5);
  else if (value.startsWith("~/")) value = context.home + value.slice(1);
  if (!value.startsWith("/")) {
    throw new OperatorBoundaryError(`policy path is not absolute: ${path}`);
  }
  const lexical = normalize(value);
  return context.canonicalize(lexical) ?? lexical;
}

function contains(parent: string, child: string): boolean {
  const p = parent.length > 1 ? parent.replace(/\/+$/, "") : parent;
  const c = child.length > 1 ? child.replace(/\/+$/, "") : child;
  return c === p || c.startsWith(p === "/" ? "/" : `${p}/`);
}

/** Fail before launch if a normal policy mount would expose operator authority.
 * The request socket remains available only through its dedicated bind at the
 * sandbox path; its host alias and every other gate artifact stay invisible. */
export function assertOperatorBoundary(
  policy: PolicyV0,
  paths: OperatorBoundaryPaths,
  context: OperatorBoundaryContext,
): void {
  const canonical = (path: string) => {
    const absolute = path.startsWith("/") ? path : `${context.pwd}/${path}`;
    const lexical = normalize(absolute);
    return context.canonicalize(lexical) ?? lexical;
  };
  const readRoots = [
    ...(policy.fs.home === "rw" ? [context.home] : []),
    ...policy.fs.rw,
    ...policy.fs.ro,
  ].map((path) => expand(path, context));
  const writeRoots = [
    ...(policy.fs.home === "rw" ? [context.home] : []),
    ...policy.fs.rw,
  ].map((path) => expand(path, context));
  const state = canonical(paths.stateDir);
  const socket = canonical(paths.requestSocket);
  const policyFile = canonical(paths.policy);

  for (const root of readRoots) {
    if (contains(root, state)) {
      throw new OperatorBoundaryError(
        `gate state ${state} is visible through policy root ${root}`,
      );
    }
    if (contains(root, socket)) {
      throw new OperatorBoundaryError(
        `gate socket host path ${socket} is visible through policy root ${root}`,
      );
    }
  }
  for (const root of writeRoots) {
    if (contains(root, policyFile)) {
      throw new OperatorBoundaryError(
        `user policy ${policyFile} is writable through policy root ${root}`,
      );
    }
  }
}
