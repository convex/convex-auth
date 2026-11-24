import { signOut, signUp } from "./auth";
import { expect, test } from "./fixtures";

test("sign-out clears the session", async ({ page, context }) => {
  await signUp(page);
  await signOut(page);

  const cookies = await context.cookies();
  expect(
    cookies.find((c) => c.name === "__convexAuthRefreshToken"),
  ).toBeUndefined();

  // The home page is no longer reachable.
  await page.goto("/");
  await expect(page).toHaveURL("/signin");
});
