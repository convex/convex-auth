/**
 * The scenario of `examples/react-username-password`: sign up, reload (the
 * session comes back from storage), wait for the refresh that the page
 * schedules before its access token expires, sign out, sign in with a wrong
 * password, sign in.
 *
 * It also declares the actions a viewer can ask for one at a time
 * (`--actions`): sign up, sign in, sign in with a wrong password, sign out,
 * reload. They fill in and submit the app's own forms. One more, "Sign in
 * while the first load is still reading", makes the race of the first load
 * happen (see {@link SLOW_STORAGE_KEY}).
 *
 * The scenario takes about a minute: the access token lives 60 s by default
 * (`packages/core/src/lib/ttl.ts`), and the page refreshes it shortly before
 * it expires.
 *
 * @module
 */
import type { Frame, Request } from "playwright-core";
import type { Observed, PageActions } from "../actions.ts";
import type { Scenario } from "../scenario.ts";

const signedIn = "button:has-text('Sign out')";

/** Whether a request calls the `refreshSession` mutation over HTTP. */
function isRefresh(request: Request): boolean {
  return (
    request.method() === "POST" &&
    new URL(request.url()).pathname === "/api/mutation" &&
    (request.postData() ?? "").includes('"auth:refreshSession"')
  );
}

type Memory = {
  /** The account the actions signed up last; null before any sign-up. */
  username: string | null;
  password: string | null;
  /** Whether the page has the script that turns on slow storage. */
  slowStorageScript: boolean;
};

/**
 * The page's `sessionStorage` key that asks the next load of the app for
 * slow storage, and the delay of each storage call in ms. The script below
 * turns it into the global `__CONVEX_AUTH_EXPLORER_STORAGE__` that
 * `examples/react-username-password/src/explorer.tsx` reads.
 *
 * With slow storage, the client's first load reads the stored session for
 * `SLOW_STORAGE_DELAY_MS`, and a sign-in made meanwhile is overwritten in
 * memory when the read answers: the race fixed by 3e952bb on
 * `erquhart/fix-init-race`, which this branch's library does not have.
 */
const SLOW_STORAGE_KEY = "__convexAuthExplorerSlowStorage";
const SLOW_STORAGE_DELAY_MS = 2500;

/** The app's explorer hook (see `src/explorer.tsx` of the example). */
type ExplorerWindow = {
  __CONVEX_AUTH_EXPLORER_SIGN_IN__?: (
    username: string,
    password: string,
  ) => Promise<string>;
};

function slowStorageScript(key: string) {
  const delay = window.sessionStorage.getItem(key);
  if (delay !== null) {
    (globalThis as Record<string, unknown>).__CONVEX_AUTH_EXPLORER_STORAGE__ = {
      delayMs: Number(delay),
    };
  }
}

const INCORRECT = "Incorrect username or password.";

/** Where the page is: signed in, or which form it shows. */
async function where(frame: Frame): Promise<"signedIn" | "form" | "other"> {
  if (await frame.locator(signedIn).isVisible()) return "signedIn";
  if (await frame.locator("#username").isVisible()) return "form";
  return "other";
}

/** Fills in and submits the form the page shows; resolves to its outcome. */
async function submit(
  frame: Frame,
  username: string,
  password: string,
): Promise<"signed in" | string> {
  const field = frame.locator("#username");
  await field.fill("");
  await field.pressSequentially(username, { delay: 15 });
  await frame.locator("#password").fill("");
  await frame.locator("#password").pressSequentially(password, { delay: 8 });
  await frame.locator("button[type=submit]").click();
  // Signed in, or the form shows an error.
  const error = frame.locator("form strong");
  await frame
    .locator(`${signedIn}, form strong`)
    .first()
    .waitFor({ timeout: 20_000 });
  if (await frame.locator(signedIn).isVisible()) return "signed in";
  return `refused: ${(await error.first().innerText()).trim()}`;
}

/** Opens the form at `path` ("/login" or "/signup") the way a person would. */
async function openForm(frame: Frame, baseUrl: string, path: string) {
  if (new URL(frame.url()).pathname === path) return;
  const link = frame.locator(`a[href='${path}']`);
  if (await link.isVisible()) await link.click();
  else await frame.goto(new URL(path, baseUrl).toString());
  await frame.waitForURL((url) => url.pathname === path);
  await frame.locator("#username").waitFor();
}

const loading = (observed: Observed) =>
  observed.loading ? "the page is loading" : null;

const actions: PageActions<Memory> = {
  memory: () => ({ username: null, password: null, slowStorageScript: false }),
  username: (memory) => memory.username,
  async observe(frame, steps) {
    // The client library's own report of its state, when it gave one.
    const state = steps.findLast(
      (s) => s.source === "convex-auth" && s.step === "state",
    );
    const reported =
      state === undefined
        ? null
        : {
            loading: state.detail.isLoading === true,
            signedIn: state.detail.isAuthenticated === true,
          };
    const shown = await where(frame);
    const loadingShown = await frame
      .getByText("Loading…")
      .isVisible()
      .catch(() => false);
    let path = "";
    try {
      path = new URL(frame.url()).pathname;
    } catch {
      // No URL yet.
    }
    return {
      // What the page shows wins over the report: the controls act on it.
      signedIn:
        shown === "signedIn"
          ? true
          : shown === "form"
            ? false
            : (reported?.signedIn ?? null),
      loading:
        shown === "other" && (loadingShown || reported?.loading === true),
      page: path,
    };
  },
  actions: [
    {
      id: "signUp",
      label: "Sign up",
      unavailable: (o) =>
        loading(o) ??
        (o.signedIn !== false ? "signed in: sign out first" : null),
      async run({ frame, baseUrl, newSecret, unique }, memory) {
        await openForm(frame, baseUrl, "/signup");
        const username = `explorer-${unique()}`;
        const password = newSecret("pw");
        memory.username = username;
        memory.password = null;
        const outcome = await submit(frame, username, password);
        if (outcome !== "signed in") throw new Error(outcome);
        memory.password = password;
        await frame.getByText(username).waitFor();
        return "signed up and signed in";
      },
    },
    {
      id: "signIn",
      label: "Sign in",
      unavailable: (o, m) =>
        loading(o) ??
        (o.signedIn !== false
          ? "already signed in"
          : m.password === null
            ? "sign up first"
            : null),
      async run({ frame, baseUrl }, memory) {
        await openForm(frame, baseUrl, "/login");
        const outcome = await submit(frame, memory.username!, memory.password!);
        if (outcome !== "signed in") throw new Error(outcome);
        return "signed in";
      },
    },
    {
      id: "signInWrongPassword",
      label: "Sign in with a wrong password",
      unavailable: (o, m) =>
        loading(o) ??
        (o.signedIn !== false
          ? "signed in: sign out first"
          : m.username === null
            ? "sign up first"
            : null),
      async run({ frame, baseUrl, newSecret }, memory) {
        await openForm(frame, baseUrl, "/login");
        const outcome = await submit(
          frame,
          memory.username!,
          newSecret("wrong"),
        );
        if (outcome !== `refused: ${INCORRECT}`)
          throw new Error(`expected the app to refuse, got: ${outcome}`);
        return outcome;
      },
    },
    {
      id: "signOut",
      label: "Sign out",
      unavailable: (o) =>
        loading(o) ?? (o.signedIn !== true ? "not signed in" : null),
      async run({ frame }) {
        await frame.locator(signedIn).click();
        await frame.waitForURL((url) => url.pathname === "/login");
        await frame.locator("#username").waitFor();
        return "signed out";
      },
    },
    {
      id: "signInDuringFirstLoad",
      label: "Sign in while the first load is still reading",
      unavailable: (o, m) =>
        loading(o) ??
        (o.signedIn !== false
          ? "signed in: sign out first"
          : m.password === null
            ? "sign up first"
            : null),
      async run({ page, frame, reload }, memory) {
        if (!memory.slowStorageScript) {
          await page.addInitScript(slowStorageScript, SLOW_STORAGE_KEY);
          memory.slowStorageScript = true;
        }
        await frame.evaluate(
          ([key, delay]) => window.sessionStorage.setItem(key, delay),
          [SLOW_STORAGE_KEY, String(SLOW_STORAGE_DELAY_MS)],
        );
        try {
          await reload();
          // The app is mounted and its first load is reading storage. The
          // form is not on screen while it loads, so sign in through the
          // app's explorer hook, which calls the same public hook as the form.
          await frame.waitForFunction(
            () =>
              (window as ExplorerWindow).__CONVEX_AUTH_EXPLORER_SIGN_IN__ !==
              undefined,
          );
          const status = await frame.evaluate(
            ([username, password]) =>
              (window as ExplorerWindow).__CONVEX_AUTH_EXPLORER_SIGN_IN__!(
                username,
                password,
              ),
            [memory.username!, memory.password!],
          );
          if (status !== "complete")
            throw new Error(`the sign-in did not complete: ${status}`);
        } finally {
          // The next load uses normal storage again.
          await frame.evaluate(
            (key) => window.sessionStorage.removeItem(key),
            SLOW_STORAGE_KEY,
          );
        }
        await Promise.race([
          frame.locator(signedIn).waitFor({ timeout: 20_000 }),
          frame.locator("#username").waitFor({ timeout: 20_000 }),
        ]);
        return (await where(frame)) === "signedIn"
          ? "signed in during the first load: the page shows signed in (slow storage until the next reload)"
          : "signed in during the first load: the page shows signed out (slow storage until the next reload)";
      },
    },
    {
      id: "reload",
      label: "Reload the page",
      unavailable: () => null,
      async run({ frame, reload }) {
        await reload();
        await Promise.race([
          frame.locator(signedIn).waitFor(),
          frame.locator("#username").waitFor(),
        ]);
        return (await where(frame)) === "signedIn"
          ? "reloaded: signed in"
          : "reloaded: signed out";
      },
    },
  ],
};

const scenario: Scenario = {
  name: "react-username-password",
  description:
    "examples/react-username-password: sign up, reload, scheduled refresh, sign out, wrong password, sign in",
  actions,
  async run({ page, frame, reload, baseUrl, step, newSecret, unique }) {
    const username = `explorer-${unique}`;
    const password = newSecret("pw");
    const wrongPassword = newSecret("wrong");
    const url = (path: string) => new URL(path, baseUrl).toString();

    await step("open the sign-up page", async () => {
      await frame.goto(url("/signup"));
      await frame.locator("#username").waitFor();
    });
    await step("sign up", async () => {
      await frame
        .locator("#username")
        .pressSequentially(username, { delay: 20 });
      await frame
        .locator("#password")
        .pressSequentially(password, { delay: 10 });
      await frame.locator("button[type=submit]").click();
      await frame.locator(signedIn).waitFor();
      await frame.getByText(username).waitFor();
    });
    await step("reload: the session comes back from storage", async () => {
      await reload();
      await frame.locator(signedIn).waitFor();
      await frame.getByText(username).waitFor();
    });
    await step(
      "wait for the scheduled refresh of the access token",
      async () => {
        // The page refreshes once right after it authenticates; wait that out,
        // then for the refresh it schedules before the token expires.
        await page.waitForTimeout(5000);
        const response = await page.waitForResponse(
          (candidate) => isRefresh(candidate.request()),
          { timeout: 120_000 },
        );
        await response.finished();
        // Let the page present the new token on its socket.
        await page.waitForTimeout(1000);
      },
    );
    await step("sign out", async () => {
      await frame.locator(signedIn).click();
      await frame.waitForURL(url("/login"));
    });
    await step("sign in with a wrong password", async () => {
      await frame
        .locator("#username")
        .pressSequentially(username, { delay: 20 });
      await frame
        .locator("#password")
        .pressSequentially(wrongPassword, { delay: 10 });
      await frame.locator("button[type=submit]").click();
      await frame.getByText("Incorrect username or password.").waitFor();
    });
    await step("sign in", async () => {
      await frame.locator("#password").fill("");
      await frame
        .locator("#password")
        .pressSequentially(password, { delay: 10 });
      await frame.locator("button[type=submit]").click();
      await frame.locator(signedIn).waitFor();
      await frame.getByText(username).waitFor();
    });
  },
};

export default scenario;
