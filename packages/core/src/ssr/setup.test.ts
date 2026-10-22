import { beforeEach, describe, expect, test, vi } from "vitest";
import { AUTH_REFRESH_COOKIE } from "./cookies.ts";
import { setupConvexAuthServer } from "./setup.ts";

// The handlers talk to Convex through a `ConvexHttpClient`; stub it so the
// tests exercise dispatch without a backend.
const { mutationMock } = vi.hoisted(() => ({ mutationMock: vi.fn() }));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    mutation = mutationMock;
  },
}));

// A placeholder function reference; the mocked client ignores it.
const fnRef = {} as never;

const auth = setupConvexAuthServer({
  convexUrl: "https://x.convex.cloud",
  refreshSession: fnRef,
  signOut: fnRef,
  signIn: [],
  cookieOptions: { secure: false },
});

// Same-origin, so the CSRF guard lets the request through to the handler.
const post = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://app.test${path}`, {
    method: "POST",
    headers: { origin: "https://app.test", host: "app.test", ...headers },
  });

beforeEach(() => mutationMock.mockReset());

describe("setupConvexAuthServer().handler", () => {
  test("routes /refresh to the refresh handler", async () => {
    mutationMock.mockResolvedValue({ kind: "noSession" });
    const res = await auth.handler(
      post("/auth/refresh", { cookie: `${AUTH_REFRESH_COOKIE}=refresh-1` }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ tokens: null });
    expect(mutationMock).toHaveBeenCalledWith(fnRef, {
      refreshToken: "refresh-1",
    });
  });

  test("routes /signout to the sign-out handler", async () => {
    mutationMock.mockResolvedValue(null);
    const res = await auth.handler(
      post("/auth/signout", { cookie: `${AUTH_REFRESH_COOKIE}=refresh-1` }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tokens: null });
    expect(mutationMock).toHaveBeenCalledWith(fnRef, {
      refreshToken: "refresh-1",
    });
  });

  test("routes /signin to the sign-in proxy", async () => {
    // Nothing is exposed, so the proxy refuses the call; reaching that
    // refusal shows the dispatch landed on the proxy.
    const res = await auth.handler(
      post("/auth/signin?path=/api/mutation", {
        "content-type": "application/json",
      }),
    );
    expect(res.status).not.toBe(404);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  test("dispatches on the last segment wherever the base is mounted", async () => {
    mutationMock.mockResolvedValue({ kind: "noSession" });
    const res = await auth.handler(post("/api/account/auth/refresh/"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ tokens: null });
  });

  test("answers 404 to an unknown route", async () => {
    const res = await auth.handler(post("/auth/other"));
    expect(res.status).toBe(404);
    expect(mutationMock).not.toHaveBeenCalled();
  });
});
