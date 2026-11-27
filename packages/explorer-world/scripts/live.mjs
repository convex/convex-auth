// Live mode: one command that runs a Convex app and shows it in the world as
// you use it.
//
//   pnpm explorer:live examples/react-username-password
//
// It starts the app's local deployment (`convex dev`), turns on the step
// reports of the project, serves the app's page, starts the recorder with a
// headless browser on that page and the timeline streamed to the world, and
// serves the world. It prints one link: open it in your own browser. The
// world's controls ask the recorder for an action (sign up, sign in, ...),
// which it performs in the hidden page; the world shows what each causes.
// Ctrl-C stops every part. When a part fails to start, the command says
// which, shows the end of its output, and stops the rest.
//
// The link carries a token of this run after `#`; the recorder's stream and
// its actions answer only requests from the world's origin that carry it
// (see `packages/explorer/src/stream.ts`).
//
// `--recorder in-page` starts no browser instead: the app's page goes
// through the recorder's page proxy, and the command prints one link to the
// stage, to open in your own browser.
//
// Plain Node, no shell: every part is a Node process started from its own
// package (the Convex CLI and Vite of the app, the recorder through tsx), so
// it runs the same on macOS, Linux, and Windows. Each part runs in its own
// process group, which is stopped as a whole.
//
// See `--help` and the README of this package.
/* global setTimeout, fetch, AbortSignal, URL -- Node globals. */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const USAGE = `Usage: pnpm explorer:live <app directory> [options]

Runs the Convex app on a local deployment, its page in a headless browser,
and the islands world, then prints one link. Open it in your own browser: the
world's controls perform actions in the hidden page (sign up, sign in, ...)
and the world shows what each causes. Ctrl-C stops everything.

Options:
  --view <which>       islands (default): the above. stage: one browser window,
                       the stage, with the app's page live on its screen for
                       you to use
  --actions <name>     The recorder's scenario whose actions the controls offer
                       (default: the app directory's name)
  --open               Also open the link in the default browser
  --headed             Show the app's window, for debugging
  --recorder <which>   cdp (default): the recorder launches its own Chromium
                       and reads it over the DevTools protocol. in-page: no
                       browser is started; the recorder's page proxy records
                       the page in your browser, from inside it (no actions;
                       not with --scenario or --debug-port)
  --project <name>     The recorder's project config (default: convex-auth)
  --page <url>         Use a page you serve yourself, against the same
                       deployment, instead of serving the app with its Vite
  --browser <which>    The browser of the app's page: chrome (the Google
                       Chrome installed on this machine), chromium (the one
                       Playwright installed), or a path to a Chromium
                       (default: chrome when installed, else chromium)
  --scenario <name>    Run a scenario of the recorder from start to end
                       instead of the controls
  --out <file>         Where to save the timeline (default: a new directory
                       under the system's temporary directory)
  --cloud              Record the cloud deployment of the app's .env.local
                       instead, with CONVEX_DEPLOY_KEY (not run here: see the
                       README)
  --settle <ms>        The longest the recorder holds a write or a call for
                       its run (default: 3000)
  --poll <ms>          How often the recorder reads the data sync (default: 100)
  --world-port <port>  The port of the world on 127.0.0.1 (default: the first
                       free one from 5174)
  --stream-port <port> The port of the recorder's stream on 127.0.0.1
                       (default: the first free one from 5199)
  --debug-port <port>  Open the window's DevTools port on 127.0.0.1, for a
                       scripted check (check:stage)`;

/** What each project of the recorder needs set on the deployment. */
const PROJECT_ENV = {
  "convex-auth": { CONVEX_AUTH_REPORT_STEPS: "true" },
};

const here = dirname(fileURLToPath(import.meta.url));
const worldRoot = resolve(here, "..");
const recorderRoot = resolve(worldRoot, "..", "explorer");
const isWindows = process.platform === "win32";

// ---------------------------------------------------------------- options --

let options;
try {
  options = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      project: { type: "string", default: "convex-auth" },
      view: { type: "string", default: "islands" },
      recorder: { type: "string" },
      actions: { type: "string" },
      open: { type: "boolean", default: false },
      page: { type: "string" },
      browser: { type: "string" },
      scenario: { type: "string" },
      headed: { type: "boolean", default: false },
      out: { type: "string" },
      // The default now; kept so that older commands still run.
      "no-open": { type: "boolean", default: false },
      cloud: { type: "boolean", default: false },
      settle: { type: "string", default: "3000" },
      poll: { type: "string", default: "100" },
      "world-port": { type: "string" },
      "stream-port": { type: "string" },
      "debug-port": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
} catch (error) {
  console.error(`${error.message}\n\n${USAGE}`);
  process.exit(2);
}
const { values, positionals } = options;
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!["stage", "islands"].includes(values.view)) {
  console.error(`--view is stage or islands, not ${values.view}.\n\n${USAGE}`);
  process.exit(2);
}
const stageView = values.view === "stage";
// The DevTools protocol drives a scenario and serves a debug port.
const needsCdp =
  values.scenario !== undefined || values["debug-port"] !== undefined;
const recorderKind = values.recorder ?? "cdp";
if (!["in-page", "cdp"].includes(recorderKind)) {
  console.error(
    `--recorder is in-page or cdp, not ${recorderKind}.\n\n${USAGE}`,
  );
  process.exit(2);
}
if (recorderKind === "in-page" && needsCdp) {
  console.error(`--scenario and --debug-port need --recorder cdp.\n\n${USAGE}`);
  process.exit(2);
}
const inPage = recorderKind === "in-page";
// Random per run: the page token lets only this run's stage load the page
// through the proxy and only its page send observations; the stream token
// lets only the stage read the timeline. Given to the recorder in its
// environment, not its arguments, which other users of the machine can list.
const pageToken = randomBytes(32).toString("base64url");
const streamToken = randomBytes(32).toString("base64url");
if (positionals.length !== 1) {
  console.error(`Give one app directory.\n\n${USAGE}`);
  process.exit(2);
}
// `pnpm --filter` runs this in its package; a path is relative to where the
// user ran pnpm.
const base = process.env.INIT_CWD ?? process.cwd();
const appDir = resolve(base, positionals[0]);
if (!existsSync(join(appDir, "convex"))) {
  console.error(`${appDir} has no convex/ directory.`);
  process.exit(2);
}
const runDir = mkdtempSync(join(tmpdir(), "explorer-live-"));
const out = values.out ? resolve(base, values.out) : join(runDir, "run.ndjson");
mkdirSync(dirname(out), { recursive: true });

const say = (message) => console.log(`explorer:live: ${message}`);

// ------------------------------------------------------------------ parts --

/** The parts started, in order; stopped in reverse. */
const parts = [];
let stopping = false;

class StartError extends Error {
  constructor(part, message) {
    super(message);
    this.part = part;
  }
}

/**
 * Starts `node <argv>` as a part: in its own process group, its output in a
 * log file of the run directory, the last lines kept for an error message.
 */
function startPart(name, argv, { cwd, env = {}, onLine } = {}) {
  if (stopping) throw new StartError(null, "Stopped while starting.");
  const log = createWriteStream(join(runDir, `${name}.log`));
  const child = spawn(process.execPath, argv, {
    cwd,
    env: { ...process.env, ...env, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: !isWindows,
    windowsHide: true,
  });
  const part = {
    name,
    child,
    tail: [],
    exited: null,
    stopped: false,
    logPath: join(runDir, `${name}.log`),
  };
  let pending = "";
  const read = (chunk) => {
    log.write(chunk);
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      part.tail.push(line);
      if (part.tail.length > 30) part.tail.shift();
      onLine?.(line);
    }
  };
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  part.done = new Promise((done) =>
    child.on("exit", (code, signal) => {
      part.exited = { code, signal };
      log.end();
      done(part.exited);
    }),
  );
  child.on("error", (error) => {
    part.exited = { code: null, signal: null, error };
  });
  parts.push(part);
  if (child.pid !== undefined) reaper?.stdin.write(`${child.pid}\n`);
  return part;
}

/** Runs `node <argv>` to its end; throws a StartError when it fails. */
async function runStep(name, argv, opts) {
  const part = startPart(name, argv, opts);
  const { code, signal } = await part.done;
  parts.splice(parts.indexOf(part), 1);
  if (code !== 0) {
    throw new StartError(
      part,
      `${name} failed (${signal ?? `exit code ${code}`}).`,
    );
  }
}

/**
 * A detached process that outlives this one: if this process ends without
 * stopping its parts (it is killed, or crashes), the reaper stops their
 * process groups. It reads the group of each part on its stdin, and `done`
 * when the parts were stopped; its stdin closing first means this process is
 * gone. Not on Windows, which has no process groups.
 */
const REAPER = `
const groups = new Set();
let done = false;
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (line === "done") done = true;
    else if (/^\\d+$/.test(line)) groups.add(Number(line));
  }
});
process.stdin.on("end", () => {
  if (done) process.exit(0);
  const kill = (signal) => {
    for (const group of groups) {
      try { process.kill(-group, signal); } catch {}
    }
  };
  kill("SIGINT");
  setTimeout(() => { kill("SIGKILL"); process.exit(0); }, 5000);
});
`;
const reaper = isWindows
  ? null
  : spawn(process.execPath, ["-e", REAPER], {
      stdio: ["pipe", "ignore", "ignore"],
      detached: true,
    });
reaper?.unref();
reaper?.stdin.on("error", () => {});

/** Whether any process of the part's group is alive. */
function groupAlive(part) {
  if (part.child.pid === undefined) return false;
  try {
    process.kill(isWindows ? part.child.pid : -part.child.pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function signalGroup(part, signal) {
  if (part.child.pid === undefined) return;
  if (isWindows) {
    // No process groups: end the tree.
    spawnSync("taskkill", ["/pid", String(part.child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-part.child.pid, signal);
  } catch {
    // Already gone.
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Stops a part: SIGINT to its process group (the recorder saves the rest of
 * its timeline, convex dev stops its backend), then SIGKILL to what is left.
 * Waits until no process of the group is alive.
 */
async function stopPart(part, graceMs) {
  part.stopped = true;
  if (groupAlive(part)) {
    signalGroup(part, "SIGINT");
    const deadline = Date.now() + graceMs;
    while (groupAlive(part) && Date.now() < deadline) await sleep(100);
    if (groupAlive(part)) {
      say(`${part.name} did not stop in ${graceMs} ms; killing it.`);
      signalGroup(part, "SIGKILL");
      while (groupAlive(part)) await sleep(50);
    }
  }
  await Promise.race([part.done, sleep(1000)]);
}

let worldServer = null;

/** Stops every part, the newest first, and the world's server. */
async function stopAll() {
  stopping = true;
  for (const part of [...parts].reverse()) {
    if (!part.stopped)
      await stopPart(part, part.name === "recorder" ? 20_000 : 10_000);
  }
  const server = worldServer;
  worldServer = null;
  await server?.close();
  if (reaper && !parts.some((part) => groupAlive(part))) {
    // Flushed before this process exits, or the reaper would act.
    await new Promise((done) => reaper.stdin.end("done\n", done));
  }
}

// ---------------------------------------------------------------- helpers --

/** Whether a port is free on one address; true when the address is absent. */
const freeOn = (port, host) =>
  new Promise((done) => {
    const server = createNetServer();
    server.once("error", (error) =>
      done(error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT"),
    );
    server.listen(port, host, () => server.close(() => done(true)));
  });

/**
 * A free port on 127.0.0.1 and on ::1, from `start` up: `localhost` can
 * reach either, so a port taken on one would take the other's requests.
 */
async function freePort(start, taken = []) {
  for (let port = start; port < start + 100; port++) {
    if (taken.includes(port)) continue;
    if ((await freeOn(port, "127.0.0.1")) && (await freeOn(port, "::1")))
      return port;
  }
  throw new Error(`No free port from ${start} to ${start + 99}.`);
}

/** Waits until `check` resolves true, or throws after `timeoutMs`. */
async function waitFor(what, timeoutMs, check, part) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (part?.exited) {
      const { code, signal } = part.exited;
      throw new StartError(
        part,
        `${what} exited (${signal ?? `exit code ${code}`}) before it was ready.`,
      );
    }
    if (Date.now() > deadline) {
      throw new StartError(
        part,
        `${what}: nothing after ${timeoutMs / 1000} s.`,
      );
    }
    await sleep(250);
  }
}

const answers = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
  await response.arrayBuffer();
  return response.ok;
};

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const vars = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) vars[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return vars;
}

const appVariables = () => ({
  ...readEnvFile(join(appDir, ".env")),
  ...readEnvFile(join(appDir, ".env.local")),
});

/** The deployment URL the app's env files name, as the recorder reads it. */
function deploymentUrl() {
  const vars = appVariables();
  for (const name of [
    "VITE_CONVEX_URL",
    "NEXT_PUBLIC_CONVEX_URL",
    "EXPO_PUBLIC_CONVEX_URL",
    "PUBLIC_CONVEX_URL",
    "CONVEX_URL",
  ]) {
    if (vars[name]) return vars[name];
  }
  return null;
}

/** The bin script of a package the app depends on. */
function appBin(pkg, bin) {
  const require = createRequire(join(appDir, "package.json"));
  let manifest;
  try {
    manifest = require.resolve(`${pkg}/package.json`);
  } catch {
    return null;
  }
  const { bin: bins } = JSON.parse(readFileSync(manifest, "utf8"));
  const path = typeof bins === "string" ? bins : bins?.[bin];
  return path ? join(dirname(manifest), path) : null;
}

/** Where Chrome is installed on this machine, or null. */
function installedChrome() {
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          join(
            homedir(),
            "Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          ),
        ]
      : isWindows
        ? [
            process.env["PROGRAMFILES"],
            process.env["PROGRAMFILES(X86)"],
            process.env.LOCALAPPDATA,
          ]
            .filter(Boolean)
            .map((dir) => join(dir, "Google/Chrome/Application/chrome.exe"))
        : ["/opt/google/chrome/chrome", "/usr/bin/google-chrome"];
  return candidates.find((path) => existsSync(path)) ?? null;
}

/** The recorder's browser options. */
function browserArgs() {
  const which = values.browser ?? (installedChrome() ? "chrome" : "chromium");
  if (which === "chrome") return ["--browser-channel", "chrome"];
  if (which === "chromium") return [];
  return ["--chromium", resolve(base, which)];
}

function openInBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : isWindows
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => say(`Open ${url} in your browser.`));
  child.unref();
}

// ------------------------------------------------------------------- main --

async function main() {
  say(`logs and the timeline go to ${runDir}`);
  const convexBin = appBin("convex", "convex");
  if (!convexBin) {
    throw new StartError(
      null,
      `The app at ${appDir} does not depend on convex; run pnpm install.`,
    );
  }

  // The deployment. Local unless --cloud: an app whose .env.local names a
  // cloud deployment is not switched to local behind its back.
  const selected = appVariables().CONVEX_DEPLOYMENT ?? "";
  const convexEnv = {};
  if (values.cloud) {
    if (!process.env.CONVEX_DEPLOY_KEY)
      throw new StartError(null, "--cloud needs CONVEX_DEPLOY_KEY.");
  } else {
    if (selected && !/^(anonymous|local):/.test(selected)) {
      throw new StartError(
        null,
        `${join(appDir, ".env.local")} names the deployment ${selected}, which is not local. ` +
          "Live mode runs a local deployment: move .env.local aside to start one, or pass --cloud.",
      );
    }
    // Without a deployment in .env.local, a logged-in CLI would ask which
    // project to use; this mode starts a local deployment with no account.
    convexEnv.CONVEX_AGENT_MODE = "anonymous";
  }

  // The world, served by Vite in this process.
  const worldPort = values["world-port"]
    ? Number(values["world-port"])
    : await freePort(5174);
  const worldOrigin = `http://127.0.0.1:${worldPort}`;
  const streamPort = values["stream-port"]
    ? Number(values["stream-port"])
    : await freePort(5199);
  const streamUrl = `http://127.0.0.1:${streamPort}/timeline`;
  // The stage's link to the stream carries its token; the recorder never
  // prints it.
  const streamLink = `${streamUrl}?token=${encodeURIComponent(streamToken)}`;
  const { createServer } = await import("vite");
  const server = await createServer({
    root: worldRoot,
    configFile: join(worldRoot, "vite.config.ts"),
    logLevel: "warn",
    clearScreen: false,
    server: { host: "127.0.0.1", port: worldPort, strictPort: true },
  });
  worldServer = server;
  await server.listen();
  if (stopping) throw new StartError(null, "Stopped while starting.");

  // The islands world's link is printed once the recorder serves its stream.
  // The stage opens in the recorder's window, once the page is served.
  let worldUrl = null;
  if (!stageView) {
    // The token goes after `#`, which the browser sends to no server; the
    // world adds it to its requests to the stream.
    worldUrl = `${worldOrigin}/?live=${encodeURIComponent(streamUrl)}&project=${encodeURIComponent(values.project)}#token=${streamToken}`;
  }

  const url0 = deploymentUrl();
  const alreadyUp =
    !values.cloud &&
    url0 !== null &&
    (await answers(`${url0}/version`).catch(() => false));
  if (alreadyUp) {
    say(
      `a deployment already answers at ${url0}; using it, and leaving it running.`,
    );
  } else {
    say("deploying the app's functions (convex dev --once)...");
    await runStep("convex-once", [convexBin, "dev", "--once"], {
      cwd: appDir,
      env: convexEnv,
    });
    say("starting the deployment (convex dev)...");
    const dev = startPart(
      "convex",
      [convexBin, "dev", "--tail-logs", "disable"],
      {
        cwd: appDir,
        env: convexEnv,
      },
    );
    await waitFor("The deployment", 120_000, async () => {
      const url = deploymentUrl();
      return url !== null && (await answers(`${url}/version`));
    });
    if (dev.exited) {
      say(
        `convex dev exited (${dev.exited.signal ?? `exit code ${dev.exited.code}`}), but the deployment answers; ` +
          `carrying on without its file watcher. Its output: ${dev.logPath}`,
      );
    }
  }
  const url = deploymentUrl();
  say(`deployment: ${url}`);

  for (const [name, value] of Object.entries(
    PROJECT_ENV[values.project] ?? {},
  )) {
    await runStep("convex-env", [convexBin, "env", "set", name, value], {
      cwd: appDir,
      env: convexEnv,
    });
    say(`set ${name}=${value} on the deployment`);
  }

  // The app's page. In-page, the proxy takes the origin the app expects
  // (localhost on the first free port from Vite's 5173) and the dev server
  // moves to another port on 127.0.0.1, behind it.
  let pageUrl = values.page;
  let proxyPort = null;
  let devServer = pageUrl ?? null;
  if (inPage) proxyPort = await freePort(5173, [worldPort, streamPort]);
  if (!pageUrl) {
    const viteBin = appBin("vite", "vite");
    if (!viteBin) {
      throw new StartError(
        null,
        "The app has no Vite to serve its page; serve the page yourself and pass --page <url>.",
      );
    }
    const port = inPage
      ? await freePort(proxyPort + 1, [worldPort, streamPort])
      : await freePort(5173);
    devServer = inPage
      ? `http://127.0.0.1:${port}`
      : `http://localhost:${port}`;
    pageUrl = inPage ? `http://localhost:${proxyPort}` : devServer;
    const page = startPart(
      "page",
      [
        viteBin,
        ...(inPage ? ["--host", "127.0.0.1"] : []),
        "--port",
        String(port),
        "--strictPort",
      ],
      { cwd: appDir },
    );
    await waitFor("The app's page", 60_000, () => answers(devServer), page);
  } else if (inPage) {
    if (!["localhost", "127.0.0.1"].includes(new URL(pageUrl).hostname)) {
      throw new StartError(
        null,
        `--page must be on this machine, not ${pageUrl}.`,
      );
    }
    pageUrl = `http://localhost:${proxyPort}`;
  }
  say(
    inPage
      ? `the app's page: ${pageUrl}, through the recorder's proxy in front of ${devServer}`
      : `the app's page: ${pageUrl}`,
  );
  // The address that loads the page the first time, with the page token.
  const screenLink = inPage
    ? `${pageUrl}/?__explorer_token=${encodeURIComponent(pageToken)}`
    : pageUrl;

  // The stage is on the same site as the page (localhost, another port), so
  // that the page in its frame keeps first-party storage and cookies.
  const stageUrl = stageView
    ? `http://localhost:${worldPort}/stage.html?screen=${encodeURIComponent(screenLink)}&live=${encodeURIComponent(streamLink)}&project=${encodeURIComponent(values.project)}`
    : null;
  if (stageUrl !== null) {
    if (new URL(pageUrl).hostname !== "localhost") {
      throw new StartError(
        null,
        `The stage shows the page from localhost; give --page on localhost, not ${pageUrl}.`,
      );
    }
    if (!inPage) say(`Stage: ${stageUrl}`);
  }

  // The recorder, streaming to the world.
  const tsx = createRequire(join(recorderRoot, "package.json")).resolve(
    "tsx/package.json",
  );
  const tsxLoader = pathToFileURL(
    join(dirname(tsx), "dist/esm/index.mjs"),
  ).href;
  let streaming = null;
  let recording = false;
  const recorder = startPart(
    "recorder",
    [
      "--import",
      tsxLoader,
      join(recorderRoot, "src/cli.ts"),
      appDir,
      "--project",
      values.project,
      ...(inPage
        ? [
            "--proxy",
            String(proxyPort),
            "--proxy-target",
            devServer,
            ...(stageView
              ? ["--proxy-stage-origin", `http://localhost:${worldPort}`]
              : []),
          ]
        : ["--page", pageUrl]),
      "--out",
      out,
      "--poll",
      values.poll,
      "--settle",
      values.settle,
      "--serve",
      String(streamPort),
      "--serve-origin",
      worldOrigin,
      "--serve-origin",
      `http://localhost:${worldPort}`,
      ...(values.cloud ? ["--cloud"] : []),
      ...(inPage
        ? []
        : [
            ...(stageUrl !== null ? ["--stage", stageUrl] : []),
            ...(values["debug-port"]
              ? ["--debug-port", values["debug-port"]]
              : []),
            ...browserArgs(),
            ...(values.scenario
              ? ["--scenario", values.scenario]
              : stageView
                ? []
                : ["--actions", values.actions ?? basename(appDir)]),
            // The stage is a window for a person; the islands view has none.
            ...(values.headed || (stageView && !values.scenario)
              ? ["--headed"]
              : []),
          ]),
    ],
    {
      cwd: recorderRoot,
      env: {
        EXPLORER_STREAM_TOKEN: streamToken,
        ...(inPage ? { EXPLORER_PAGE_TOKEN: pageToken } : {}),
      },
      onLine: (line) => {
        const found = /Streaming the timeline at (\S+)/.exec(line);
        if (found) streaming = found[1];
        if (/^(Recording |Running the scenario)/.test(line)) recording = true;
        if (
          /^(Recording |Running the scenario|The scenario|Wrote |Action |A \w+ event held)/.test(
            line,
          )
        )
          say(`recorder: ${line}`);
      },
    },
  );
  await waitFor(
    "The recorder",
    120_000,
    // The stream comes up first, then the snapshot of the data, then the
    // browser; the recorder is ready when it says it records.
    async () => streaming !== null && recording,
    recorder,
  );
  if (inPage) {
    // The one link: it carries the run's tokens, so it is printed here and
    // nowhere else (not in the logs of the run directory).
    console.log(
      `\n  Open in your browser:\n\n    ${stageView ? stageUrl : screenLink}\n`,
    );
  }
  if (worldUrl !== null) {
    // The one link of the world, printed once everything answers.
    console.log(`\n  World: ${worldUrl}\n`);
    if (values.open) openInBrowser(worldUrl);
  }
  say(
    values.scenario
      ? `running the scenario ${values.scenario}; Ctrl-C to stop.`
      : stageView
        ? "use the app on the stage's screen. Ctrl-C stops everything."
        : inPage
          ? "use the app at the link above; the world shows what it does. Ctrl-C stops everything."
          : "open the link above; its controls drive the app. Ctrl-C stops everything.",
  );

  recorder.done.then(({ code, signal }) => {
    if (stopping) return;
    say(
      `the recording ended (${signal ?? `exit code ${code}`}); it is saved in ${out}. ` +
        "The world still shows it; Ctrl-C to stop.",
    );
  });
  for (const part of parts) {
    if (part === recorder) continue;
    part.done.then(({ code, signal }) => {
      if (!stopping && part.name !== "convex")
        say(
          `${part.name} stopped (${signal ?? `exit code ${code}`}); see ${part.logPath}`,
        );
    });
  }
}

let stopRequested = null;
const stopped = new Promise((done) => (stopRequested = done));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    stopping = true;
    stopRequested(signal);
  });
}

const starting = main();
try {
  await Promise.race([starting, stopped]);
  await stopped;
  say("stopping...");
  await stopAll();
  // A part that was starting when the signal came is stopped too.
  await Promise.race([starting.catch(() => {}), sleep(5000)]);
  await stopAll();
  say(`stopped. The timeline is in ${out}`);
  process.exit(0);
} catch (error) {
  if (error instanceof StartError) {
    const part = error.part;
    console.error(`explorer:live: could not start: ${error.message}`);
    if (part?.tail.length) {
      console.error(
        `--- the end of the output of ${part.name} (${part.logPath}):`,
      );
      console.error(part.tail.join("\n"));
      console.error("---");
    }
  } else {
    console.error(`explorer:live: ${error.stack ?? error}`);
  }
  await stopAll();
  process.exit(1);
}
