import { SignJWT } from "jose";
import { expect, test } from "./fixtures";

test("a forged access token cookie doesn't sign in", async ({
  page,
  context,
}) => {
  // A JWT that's otherwise valid, but not signed by the deployment.
  const jwt = await new SignJWT({ sub: "forged" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer("https://example.com")
    .setAudience("convex")
    .setExpirationTime("12h")
    .sign(new TextEncoder().encode("test-secret"));
  await context.addCookies([
    { name: "__convexAuthJWT", value: jwt, path: "/", domain: "localhost" },
    {
      name: "__convexAuthRefreshToken",
      value: "foobar",
      path: "/",
      domain: "localhost",
    },
  ]);

  await page.goto("/");
  await expect(page).toHaveURL("/signin");
});

test("the auth routes refuse cross-site requests", async ({ request }) => {
  const response = await request.post("/auth/refresh", {
    headers: { origin: "https://evil.example.com" },
    data: {},
  });
  expect(response.status()).toBe(403);
});
