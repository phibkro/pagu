// pure: derive the egress allowlist entry (host:port) from a provider baseURL.
/**
 * The VM tier's default egress is **model-host-only**; this turns a provider
 * `baseURL` into the `host:port` the launcher allowlists. Port defaults by
 * scheme (https→443, http→80) when not explicit. Throws on an unparseable URL
 * (a config error — fail loud rather than silently widen/deny egress).
 */
export function modelHostFromBaseURL(baseURL: string): string {
  const u = new URL(baseURL); // throws on garbage → fail loud
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  return `${u.hostname}:${port}`;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Rewrite a **loopback** model URL to the podman host gateway
 * (`host.containers.internal`) so a guest on the default network reaches a
 * host-side model — without `--network=host` (which would share the host's
 * whole net namespace). A remote URL is returned **unchanged** (no
 * normalization). Egress is still broader than the model host until the
 * model-host-only mechanism lands (task #46); this is the reachability half.
 */
export function guestModelURL(baseURL: string): string {
  const u = new URL(baseURL);
  if (!LOOPBACK.has(u.hostname)) return baseURL;
  u.hostname = "host.containers.internal";
  return u.toString();
}
