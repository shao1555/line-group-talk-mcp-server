export function applicationOrigin(env: Env): string {
  return env.REQUEST_ORIGIN ?? new URL(env.PORTAL_ORIGIN).origin;
}

export function envForRequest(request: Request, env: Env): Env {
  const actual = new URL(request.url).origin;
  const canonical = new URL(env.PORTAL_ORIGIN).origin;
  const legacy = new URL(env.LEGACY_PORTAL_ORIGIN).origin;
  // Preserve old issuer/resource/callback URLs for existing clients. A request to
  // any other hostname cannot influence OAuth metadata or callback destinations.
  return { ...env, REQUEST_ORIGIN: actual === legacy ? legacy : canonical };
}
