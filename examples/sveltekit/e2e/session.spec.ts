import { execFileSync } from "node:child_process";
import { decodeJwt } from "jose";
import { signUp } from "./auth";
import { expect, test } from "./fixtures";

// The example keeps the default access-token TTL of one minute.
const ACCESS_TOKEN_TTL_MS = 60_000;

test("the session outlives its access token", async ({ page }) => {
  test.setTimeout(4 * ACCESS_TOKEN_TTL_MS);
  const username = await signUp(page);

  // Leave the app, so no client refreshes the token, and let it expire. The
  // handle hook refreshes it from the cookie before rendering.
  await page.goto("about:blank");
  await page.waitForTimeout(ACCESS_TOKEN_TTL_MS + 5_000);
  const response = await page.goto("/");
  await expect(page).toHaveURL("/");
  expect(await response!.text()).toContain(username);

  // Stay on the page past the next expiry: the client refreshes through the
  // refresh route, and stays signed in.
  await page.waitForResponse(
    (response) =>
      response.url().endsWith("/auth/refresh") && response.status() === 200,
    { timeout: ACCESS_TOKEN_TTL_MS + 30_000 },
  );
  await page.reload();
  await expect(page.getByText(`Signed in as ${username}`)).toBeVisible();
});

test("a session revoked on the server signs the browser out", async ({
  page,
  context,
}) => {
  await signUp(page);

  const jwt = (await context.cookies()).find(
    (c) => c.name === "__convexAuthJWT",
  );
  expect(jwt).toBeDefined();
  // The `sub` of an access token is the session id.
  const sessionId = decodeJwt(jwt!.value).sub!;
  execFileSync(
    "npx",
    [
      "convex",
      "run",
      "--component",
      "auth",
      "public:revokeSessions",
      JSON.stringify({ sessionIds: [sessionId] }),
    ],
    { stdio: "pipe" },
  );

  // The client watches `isAuthenticated`, so it signs out without waiting for
  // the access token to expire, and the server no longer lets it in.
  await expect
    .poll(async () =>
      (await context.cookies()).some((c) => c.name === "__convexAuthJWT"),
    )
    .toBe(false);
  await page.goto("/");
  await expect(page).toHaveURL("/signin");
});
