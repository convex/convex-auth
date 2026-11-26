/**
 * Records the scenario of `examples/react-username-password` on a running
 * local deployment, with the browser feed and the `convex-auth` project
 * config, then checks the timeline:
 *
 * 1. Each call that the page made is linked to a run, or says why not. A
 *    mutation linked by its commit time owns the writes of that time.
 * 2. Each refresh token can be followed: the response that returned it, the
 *    storage that kept it, the request that presented it, and the states of
 *    its row in `refreshTokens`. The one of the sign-up goes from `issued`
 *    to `redeemed` to `spent`.
 * 3. Each access token that the page presented on its socket is a JWT with a
 *    session (`sub`), linked to its row in `sessions`, and an expiry (`exp`).
 * 4. The file holds none of the secrets that the recorder saw (raw tokens,
 *    raw hashes, the passwords that the scenario typed, the admin key), no
 *    `eyJ`, no PHC string, and no 64-hex string.
 *
 * ```sh
 * pnpm --filter @convex-dev/explorer check:browser examples/react-username-password \
 *   --page http://localhost:5173 [--out run.ndjson]
 * ```
 *
 * The page must be served against the deployment (e.g. `npx vite` in the
 * app's directory), and the deployment should have
 * `CONVEX_AUTH_REPORT_STEPS=true`. Takes about 90 seconds.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readAppVariables, readLocalAdminKey } from "../src/appFiles.ts";
import { resolveTarget } from "../src/config.ts";
import type {
  HttpEvent,
  SecretEvent,
  SecretLinkEvent,
  SocketEvent,
  StorageEvent,
  TimelineEvent,
  WriteEvent,
} from "../src/events.ts";
import { convexAuthProject } from "../src/projects/convexAuth.ts";
import { record } from "../src/recorder.ts";
import scenario from "../src/scenarios/reactUsernamePassword.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    page: { type: "string" },
    out: { type: "string" },
  },
});
if (positionals.length !== 1 || values.page === undefined) {
  console.error(
    "Usage: check:browser <app directory> --page <url> [--out <file>]",
  );
  process.exit(2);
}
const base = process.env.INIT_CWD ?? process.cwd();
const appDir = resolve(base, positionals[0]);
const out =
  values.out === undefined
    ? join(mkdtempSync(join(tmpdir(), "explorer-browser-")), "run.ndjson")
    : resolve(base, values.out);
const target = resolveTarget({
  target: "local",
  appVariables: readAppVariables(appDir),
  env: process.env,
  url: undefined,
  localAdminKey: readLocalAdminKey(appDir),
});

// Raw secrets, in memory only.
const secrets = new Set<string>([target.key]);
const { code } = await record(
  {
    ...target,
    out,
    project: convexAuthProject,
    history: 0,
    pollMs: 1000,
    settleMs: 3000,
    browser: { url: values.page, scenario, headed: false },
  },
  { onRawSecret: (value) => secrets.add(value) },
);
if (code !== 0) {
  console.error(`The recording failed (exit code ${code}).`);
  process.exit(1);
}

const text = readFileSync(out, "utf8");
const events = text
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as TimelineEvent);
const of = <Kind extends TimelineEvent["kind"]>(kind: Kind) =>
  events.filter(
    (event): event is Extract<TimelineEvent, { kind: Kind }> =>
      event.kind === kind,
  );
let failures = 0;
const fail = (message: string) => {
  failures++;
  console.log(`FAIL ${message}`);
};
const ok = (message: string) => console.log(`ok   ${message}`);

/** Whether a JSON value holds the reference to `label`. */
function holds(value: unknown, label: string): boolean {
  if (Array.isArray(value)) {
    return value.some((inner) => holds(inner, label));
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return (
      record.$secret === label ||
      Object.values(record).some((inner) => holds(inner, label))
    );
  }
  return false;
}

/** The secret label at `tokens.refreshToken` of a result, if any. */
function refreshTokenOf(result: unknown): string | null {
  const tokens = (result as { tokens?: { refreshToken?: unknown } } | null)
    ?.tokens;
  const ref = tokens?.refreshToken as { $secret?: unknown } | undefined;
  return typeof ref?.$secret === "string" ? ref.$secret : null;
}

// 1. Calls.
const calls = of("call");
const runs = new Map(of("run").map((run) => [run.id, run]));
const writes = of("write");
let linked = 0;
for (const call of calls) {
  if (call.runId !== null) {
    linked++;
    const run = runs.get(call.runId);
    if (run === undefined || run.identifier !== call.identifier) {
      fail(
        `${call.id} links to ${call.runId}, which is not a run of ${call.identifier}`,
      );
    }
    if (call.commitTs !== null) {
      const own = writes.filter((write) => write.ts === call.commitTs);
      if (own.some((write) => write.runId !== call.runId)) {
        fail(`${call.id}: a write of its commit time belongs to another run`);
      }
      if (run !== undefined && own.length !== run.writeCount) {
        fail(
          `${call.id}: ${own.length} writes at its commit time, the run wrote ${run.writeCount}`,
        );
      }
    }
  } else if (call.unlinked === null || call.unlinked === "") {
    fail(`${call.id} (${call.identifier}) has no run and no reason`);
  } else {
    console.log(
      `     unlinked ${call.id} ${call.udfType} ${call.identifier}: ${call.unlinked}` +
        (call.candidateRunIds.length > 0
          ? ` [candidates: ${call.candidateRunIds.join(", ")}]`
          : ""),
    );
  }
}
const mutations = calls.filter((call) => call.udfType !== "Query");
const linkedMutations = mutations.filter((call) => call.runId !== null);
ok(
  `${calls.length} calls, ${linked} linked (by commit time: ${calls.filter((call) => call.link === "commitTs").length}, by window: ${calls.filter((call) => call.link === "window").length}); mutations and actions: ${linkedMutations.length} of ${mutations.length} linked`,
);
if (linkedMutations.length !== mutations.length) {
  fail("a mutation or an action of the page has no run");
}
const refreshCalls = calls.filter(
  (call) => call.identifier === "auth:refreshSession",
);
const scheduled = refreshCalls.filter(
  (call) => call.time - events[0].time > 30_000,
);
if (scheduled.length === 0) {
  fail("no refresh that the page scheduled before the token expired");
} else {
  ok(
    `${refreshCalls.length} refreshes, ${scheduled.length} scheduled by the page before expiry`,
  );
}

// 2. Refresh tokens.
const secretEvents = new Map(of("secret").map((secret) => [secret.id, secret]));
const links = of("secretLink");
// Each response that returned a refresh token, in order of time.
const issuers: { event: SocketEvent | HttpEvent; token: string }[] = [];
for (const event of [...of("socket"), ...of("http")]) {
  const token =
    event.kind === "socket"
      ? event.type === "MutationResponse"
        ? refreshTokenOf(event.message.result)
        : null
      : refreshTokenOf(event.response?.value);
  if (token !== null) {
    issuers.push({ event, token });
  }
}
issuers.sort((a, b) => a.event.time - b.event.time);
if (issuers.length === 0) {
  fail("no response returned a refresh token");
}
for (const [index, { event, token }] of issuers.entries()) {
  const stored = of("storage").find(
    (change: StorageEvent) => change.op === "set" && holds(change.value, token),
  );
  const presented = of("http").filter(
    (request) => request.request !== null && holds(request.request.args, token),
  );
  const row = links.find(
    (link: SecretLinkEvent) =>
      link.secret === token && link.table === "refreshTokens",
  );
  const states =
    row === undefined
      ? []
      : writes
          .filter((write: WriteEvent) => write.documentId === row.documentId)
          .map((write) =>
            write.deleted ? "deleted" : String(write.value?.state),
          )
          .filter((state, i, all) => i === 0 || all[i - 1] !== state);
  const journey =
    `${token}: returned by ${event.id} (${event.kind})` +
    `, stored ${stored === undefined ? "NEVER" : `by ${stored.id}`}` +
    `, presented by ${presented.length === 0 ? "nothing" : presented.map((request) => `${request.id} (${request.request?.path})`).join(", ")}` +
    `, row ${row === undefined ? "NONE" : `${row.component}/refreshTokens/${row.documentId}`}: ${states.join(" -> ") || "no writes"}`;
  if (stored === undefined || row === undefined || states[0] !== "issued") {
    fail(journey);
  } else {
    ok(journey);
  }
  if (index === 0) {
    const complete =
      presented.length > 0 &&
      states.includes("redeemed") &&
      (states.includes("spent") || states.includes("deleted"));
    if (!complete) {
      fail(`the refresh token of the sign-up has no complete journey`);
    }
  }
}

// 3. Access tokens on the socket.
const authenticates = of("socket").filter(
  (event) =>
    event.type === "Authenticate" && event.message.tokenType === "User",
);
if (authenticates.length === 0) {
  fail("the page never presented an access token");
}
for (const event of authenticates) {
  const label = (event.message.value as { $secret?: string } | null)?.$secret;
  const secret: SecretEvent | undefined =
    label === undefined ? undefined : secretEvents.get(label);
  const sub = secret?.claims?.sub;
  const exp = secret?.claims?.exp;
  const session = links.find(
    (link) => link.secret === label && link.table === "sessions",
  );
  const line = `${event.id} presents ${label}: session ${String(sub)}, expires ${typeof exp === "number" ? new Date(exp * 1000).toISOString() : "?"}, row ${session === undefined ? "NONE" : `${session.component}/sessions/${session.documentId}`}`;
  if (
    secret?.type !== "jwt" ||
    typeof sub !== "string" ||
    typeof exp !== "number" ||
    session?.documentId !== sub
  ) {
    fail(line);
  } else {
    ok(line);
  }
}

// 4. Secrets.
const leaks = [...secrets].filter(
  (secret) => secret.length >= 8 && text.includes(secret),
);
if (leaks.length > 0) {
  fail(`${leaks.length} of ${secrets.size} known secrets are in the file`);
} else {
  ok(`none of ${secrets.size} known secrets is in the file`);
}
for (const [name, pattern] of [
  ["eyJ", /eyJ/],
  ["a PHC string", /\$argon2|\$scrypt/],
  ["a 64-hex string", /[0-9a-fA-F]{64}/],
] as const) {
  if (pattern.test(text)) {
    fail(`the file holds ${name}`);
  } else {
    ok(`no ${name}`);
  }
}

console.log(
  `${failures === 0 ? "PASS" : "FAIL"}: ${events.length} events in ${out}`,
);
process.exit(failures === 0 ? 0 : 1);
