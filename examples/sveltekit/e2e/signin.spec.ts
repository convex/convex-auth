import { PASSWORD, signIn, signOut, signUp, uniqueUsername } from "./auth";
import { expect, test } from "./fixtures";

test("a signed-out visitor is sent to the sign-in page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL("/signin");
});

test("sign-up signs in, and the server renders the page signed in", async ({
  page,
}) => {
  const username = await signUp(page);

  // The HTML of the reload comes from the server, rendered with the session
  // of the cookies.
  const response = await page.reload();
  expect(page.url()).toMatch(/\/$/);
  expect(await response!.text()).toContain(username);
});

test("sign-up with a taken username fails", async ({ page, browser }) => {
  const username = await signUp(page);

  const other = await browser.newPage();
  await other.goto("/signup");
  await other.getByRole("textbox", { name: "Username" }).fill(username);
  await other.getByLabel("Password").fill(PASSWORD);
  await other.getByRole("button", { name: "Create account" }).click();
  await expect(other.getByRole("alert")).toHaveText(
    "That username is already taken.",
  );
  await other.close();
});

test("sign-in with an existing account", async ({ page }) => {
  const username = await signUp(page);
  await signOut(page);

  await signIn(page, username);
  await page.waitForURL("/");
  await expect(page.getByText(`Signed in as ${username}`)).toBeVisible();
});

test("sign-in with an unknown username fails", async ({ page }) => {
  await signIn(page, uniqueUsername());
  await expect(page.getByRole("alert")).toHaveText(
    "No account exists with that username.",
  );
});

test("sign-in with a wrong password fails", async ({ page }) => {
  const username = await signUp(page);
  await signOut(page);

  await signIn(page, username, `${PASSWORD}!`);
  await expect(page.getByRole("alert")).toHaveText(
    "Incorrect username or password.",
  );
});

test("a signed-in visitor of the sign-in page is sent home", async ({
  page,
}) => {
  await signUp(page);
  await page.goto("/signin");
  await expect(page).toHaveURL("/");
});

test("the refresh token stays in an httpOnly cookie", async ({
  page,
  context,
}) => {
  await signUp(page);

  const cookies = await context.cookies();
  const refresh = cookies.find((c) => c.name === "__convexAuthRefreshToken");
  expect(refresh?.httpOnly).toBe(true);
  const readable = await page.evaluate(() =>
    JSON.stringify({ cookie: document.cookie, ...window.localStorage }),
  );
  expect(readable).not.toContain(refresh!.value);
});

test("a signed-in page settles instead of refreshing in a loop", async ({
  page,
}) => {
  await signUp(page);
  let refreshes = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/auth/refresh") refreshes++;
  });
  await page.reload();
  await page.waitForTimeout(3_000);
  expect(refreshes).toBeLessThanOrEqual(2);
});
