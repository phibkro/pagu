// effects: establish a private, stable operator-state directory.

export class UnsafeStateDirectoryError extends Error {
  override name = "UnsafeStateDirectoryError";
}

function dirname(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const slash = trimmed.lastIndexOf("/");
  return slash <= 0 ? "/" : trimmed.slice(0, slash);
}

/** Create the final directory if absent, then prove another OS user cannot
 * replace it through a writable non-sticky ancestor. */
export async function ensurePrivateStateDirectory(path: string): Promise<void> {
  if (!path.startsWith("/")) {
    throw new UnsafeStateDirectoryError(
      "gate state directory must be absolute",
    );
  }
  await Deno.mkdir(path, { recursive: true, mode: 0o700 });
  const state = await Deno.lstat(path);
  if (!state.isDirectory || state.isSymlink) {
    throw new UnsafeStateDirectoryError(
      `gate state is not a real directory: ${path}`,
    );
  }
  // Derive the process filesystem identity without requesting Deno's broad
  // `--allow-sys=uid`: a create-new probe is owned by this effective user.
  const ownerProbe = `${path}/.owner-${crypto.randomUUID()}`;
  await Deno.writeTextFile(ownerProbe, "", { createNew: true, mode: 0o600 });
  const uid = (await Deno.lstat(ownerProbe)).uid;
  await Deno.remove(ownerProbe);
  if (state.uid !== null && state.uid !== uid) {
    throw new UnsafeStateDirectoryError(
      `gate state is owned by uid ${state.uid}, expected ${uid}`,
    );
  }
  if (state.mode === null || (state.mode & 0o077) !== 0) {
    throw new UnsafeStateDirectoryError(
      `gate state must deny group/other access: ${path}`,
    );
  }

  let parent = dirname(path);
  while (true) {
    const info = await Deno.lstat(parent);
    if (info.isSymlink) {
      throw new UnsafeStateDirectoryError(
        `gate state ancestor may not be a symlink: ${parent}`,
      );
    }
    const mode = info.mode ?? 0;
    const writableByOthers = (mode & 0o022) !== 0;
    const sticky = (mode & 0o1000) !== 0;
    const trustedStickyOwner = info.uid === null || info.uid === 0 ||
      info.uid === uid;
    if (writableByOthers && (!sticky || !trustedStickyOwner)) {
      throw new UnsafeStateDirectoryError(
        `gate state ancestor is replaceable by another user: ${parent}`,
      );
    }
    if (parent === "/") break;
    parent = dirname(parent);
  }
}
