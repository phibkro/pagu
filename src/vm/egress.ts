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
