import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";

/**
 * `test` whose `page.goto` and `page.reload` also wait until the app has
 * hydrated, so the first click of a test never lands on a control without
 * its handler.
 */
export const test = base.extend({
  page: async ({ page, baseURL }, use) => {
    const waitForHydration = async (
      response: Awaited<ReturnType<typeof page.goto>>,
    ) => {
      const html = response?.headers()["content-type"]?.includes("text/html");
      if (html && baseURL && page.url().startsWith(baseURL)) {
        await page
          .locator("html[data-hydrated]")
          .waitFor({ state: "attached" });
      }
      return response;
    };
    const goto = page.goto.bind(page);
    page.goto = async (url, options) =>
      waitForHydration(await goto(url, options));
    const reload = page.reload.bind(page);
    page.reload = async (options) => waitForHydration(await reload(options));
    await use(page);
  },
});
