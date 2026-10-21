import { parse, serialize } from "cookie";
import { CookieOptions, CookieStore } from "./cookies.ts";

/**
 * Serialize a cookie into a `Set-Cookie` header value.
 *
 * Thin adapter over the `cookie` package's `serialize` that maps our
 * {@link CookieOptions} onto it.
 *
 * Deletion is expressed by the caller as an empty value with `maxAge: 0` (and a
 * past `expires`); see {@link httpCookies}'s `delete`.
 */
export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions = {},
): string {
  return serialize(name, value, {
    path: options.path ?? "/",
    maxAge:
      options.maxAge === undefined ? undefined : Math.floor(options.maxAge),
    expires: options.expires,
    domain: options.domain,
    httpOnly: options.httpOnly,
    secure: options.secure,
    sameSite: options.sameSite,
  });
}

/**
 * A {@link CookieStore} that also knows how to write its buffered mutations onto
 * a response's headers. Build one per request; after driving a
 * {@link ServerAuthSession} with it, call {@link HttpCookies.applyTo} on the
 * response you return.
 */
export interface HttpCookies extends CookieStore {
  /** Append a `Set-Cookie` header for every write/delete made on this store. */
  applyTo: (headers: Headers) => void;
}

/**
 * Adapt an incoming {@link Request}'s cookies to a {@link CookieStore}.
 *
 * The returned {@link HttpCookies} object allows applying changes to the
 * cookies via the {@link HttpCookies#applyTo} function. Pass it {@link
 * Response} `Headers` and it will write the cookie values.
 *
 * ```ts
 * const client = new ConvexHttpClient(process.env.CONVEX_URL!);
 * const cookies = httpCookies(request);
 * const session = new ServerAuthSession({
 *   refreshSession: (refreshToken) =>
 *     client.mutation(api.auth.refreshSession, { refreshToken }),
 *   cookies,
 *   cookieOptions: { secure: true },
 * });
 * const result = await session.refresh();
 * const res = Response.json({
 *   tokens: result.kind === "rotated" ? makeSlimBundle(result.tokens) : null,
 * });
 * cookies.applyTo(res.headers);
 * return res;
 * ```
 */
export function httpCookies(request: Request): HttpCookies {
  // `cookie`'s `parse` tolerates malformed percent-encoding on foreign cookies
  // (falling back to the raw value) rather than throwing and failing the whole
  // request.
  const jar = parse(request.headers.get("cookie") ?? "");
  // Reflect writes back to reads within the same request, and remember them as
  // serialized Set-Cookie headers to flush onto the response.
  const overlay = new Map<string, string | null>();
  const pending: string[] = [];
  return {
    get(name) {
      if (overlay.has(name)) return overlay.get(name) ?? undefined;
      return jar[name];
    },
    set(name, value, options) {
      overlay.set(name, value);
      pending.push(serializeCookie(name, value, options));
    },
    delete(name, options) {
      overlay.set(name, null);
      pending.push(
        serializeCookie(name, "", {
          path: options?.path ?? "/",
          domain: options?.domain,
          maxAge: 0,
          expires: new Date(0),
        }),
      );
    },
    applyTo(headers) {
      for (const cookie of pending) headers.append("set-cookie", cookie);
    },
  };
}
