import { expect, type Page } from "@playwright/test";

export const PASSWORD = "correct horse battery staple";

/** A username no other test run has used. */
export function uniqueUsername() {
  return `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function fillForm(page: Page, username: string, password: string) {
  await page.getByRole("textbox", { name: "Username" }).fill(username);
  await page.getByLabel("Password").fill(password);
}

/** Create an account through the sign-up page, which also signs it in. */
export async function signUp(page: Page, username = uniqueUsername()) {
  await page.goto("/signup");
  await fillForm(page, username, PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("/");
  await expect(page.getByText(`Signed in as ${username}`)).toBeVisible();
  return username;
}

/** Sign in to an existing account through the sign-in page. */
export async function signIn(
  page: Page,
  username: string,
  password = PASSWORD,
) {
  await page.goto("/signin");
  await fillForm(page, username, password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

export async function signOut(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("/signin");
}
