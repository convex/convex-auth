/**
 * Tells when the session of an `AuthClient` changes in a way that makes data
 * loaded for the old one stale: signing in, signing out, or switching to
 * another session. A token refresh keeps the session, so it doesn't count.
 *
 * @module
 */

import type { AuthState } from "../browser/sessionManager.ts";

/** The session id of an access token: its `sub` claim. */
export function sessionOf(token: string | null): string | null {
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const sub: unknown = JSON.parse(atob(base64)).sub;
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}

/**
 * Returns a function to call with each snapshot of the `AuthClient`. It
 * returns `true` when the snapshot is in another session than the last
 * loaded one.
 *
 * @param rendered With SSR, the access token the server rendered with, or
 *   `null` when it rendered signed out: a client that finishes loading in
 *   another session, for example after redeeming an OAuth code, reports a
 *   change. Without SSR, `undefined`: the first loaded snapshot is the
 *   baseline.
 */
export function createAuthChangeDetector(
  rendered: string | null | undefined,
): (snapshot: AuthState) => boolean {
  // `false` stands for "signed in, session unknown", for a token without a
  // readable `sub`.
  const key = (signedIn: boolean, token: string | null) =>
    signedIn ? (sessionOf(token) ?? false) : null;
  let last: string | false | null | undefined =
    rendered === undefined ? undefined : key(rendered !== null, rendered);
  return (snapshot) => {
    if (snapshot.isLoading) return false;
    const next = key(snapshot.isAuthenticated, snapshot.token);
    const changed = last !== undefined && last !== next;
    last = next;
    return changed;
  };
}
