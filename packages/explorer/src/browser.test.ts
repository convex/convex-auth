import { describe, expect, test } from "vitest";
import {
  readPageStep,
  BrowserRedactor,
  CallTracker,
  decodeSyncTs,
  diffCookies,
  httpApiType,
  readInput,
  SocketReader,
} from "./browser.ts";
import {
  REDACTED,
  type HttpEvent,
  type SecretLinkEvent,
  type SocketEvent,
  type StorageEvent,
  type TimelineEvent,
} from "./events.ts";
import { nodeDigest } from "./nodeDigest.ts";
import { GENERIC_BROWSER, GENERIC_PROJECT } from "./project.ts";
import { convexAuthProject } from "./projects/convexAuth.ts";
import { Secrets } from "./secrets.ts";
import {
  browserFixture,
  FIXTURE_PASSWORDS,
  replayBrowserFixture,
} from "./testFixtures.ts";
import { mergeTimeline } from "./timeline.ts";

const of = <Kind extends TimelineEvent["kind"]>(
  events: readonly TimelineEvent[],
  kind: Kind,
) =>
  events.filter(
    (event): event is Extract<TimelineEvent, { kind: Kind }> =>
      event.kind === kind,
  );

const ref = (value: unknown) => (value as { $secret?: string } | null)?.$secret;

describe("the browser feed of a real session", () => {
  const { events, rawSecrets, skew } = replayBrowserFixture(convexAuthProject);
  const text = JSON.stringify(events);

  test("holds no token, no hash, and no password", () => {
    expect(rawSecrets.length).toBeGreaterThan(0);
    for (const secret of [...rawSecrets, ...FIXTURE_PASSWORDS]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/eyJ|[0-9a-f]{64}/);
  });

  test("follows the refresh token of the sign-up from the response to storage to the refresh", () => {
    const signUp = of(events, "socket").find(
      (event) => event.type === "MutationResponse",
    )!;
    const result = signUp.message.result as { tokens: Record<string, unknown> };
    const token = ref(result.tokens.refreshToken)!;
    expect(token).toMatch(/^s\d+$/);
    const stored = of(events, "storage").find(
      (event: StorageEvent) =>
        event.key?.startsWith("__convexAuthRefreshToken") === true &&
        ref(event.value) === token,
    );
    expect(stored).toBeDefined();
    const refresh = of(events, "http").find(
      (event: HttpEvent) => event.request?.path === "auth:refreshSession",
    )!;
    expect(refresh.request!.args).toEqual([
      { refreshToken: { $secret: token } },
    ]);
    // The refresh rotates it: storage replaces it with the token of the response.
    const rotated = ref(
      (refresh.response!.value as { tokens: Record<string, unknown> }).tokens
        .refreshToken,
    );
    expect(
      of(events, "storage").some(
        (event) =>
          ref(event.value) === rotated && ref(event.oldValue) === token,
      ),
    ).toBe(true);
  });

  test("links the tokens of the live session to their rows", () => {
    const links = of(events, "secretLink");
    const rows = browserFixture.documents;
    // The data sync held the rows of the second session only.
    expect(
      links.filter((link: SecretLinkEvent) => link.table === "refreshTokens"),
    ).toHaveLength(rows.filter((row) => row.table === "refreshTokens").length);
    const session = rows.find((row) => row.table === "sessions")!;
    const lastAuthenticate = of(events, "socket")
      .filter((event: SocketEvent) => event.type === "Authenticate")
      .at(-1)!;
    const label = ref(lastAuthenticate.message.value)!;
    const secret = of(events, "secret").find((event) => event.id === label)!;
    expect(secret.type).toBe("jwt");
    expect(secret.claims).toMatchObject({
      sub: session.documentId,
      aud: "convex-auth",
    });
    expect(typeof secret.claims!.exp).toBe("number");
    expect(links).toContainEqual(
      expect.objectContaining({
        secret: label,
        table: "sessions",
        documentId: session.documentId,
      }),
    );
  });

  test("keeps the username, replaces the password", () => {
    const mutations = of(events, "socket").filter(
      (event) => event.type === "Mutation",
    );
    expect(mutations).toHaveLength(3);
    for (const mutation of mutations) {
      expect(mutation.message.args).toEqual([
        { password: REDACTED, username: expect.stringMatching(/^fixture-/) },
      ]);
    }
    const failed = of(events, "socket").filter(
      (event) => event.type === "MutationResponse",
    )[1];
    expect(failed.message.result).toEqual({
      status: "error",
      userError: { error: "INVALID_CREDENTIALS" },
    });
  });

  test("replaces the username when the project drops personal data", () => {
    const dropped = replayBrowserFixture({
      ...convexAuthProject,
      keepPersonalData: false,
    });
    const mutation = of(dropped.events, "socket").find(
      (event) => event.type === "Mutation",
    )!;
    expect(mutation.message.args).toEqual([
      { password: REDACTED, username: REDACTED },
    ]);
    expect(JSON.stringify(dropped.events)).not.toMatch(/fixture-\d/);
  });

  test("replaces every token without a project config, and links nothing", () => {
    const generic = replayBrowserFixture(GENERIC_PROJECT);
    const genericText = JSON.stringify(generic.events);
    for (const secret of generic.rawSecrets) {
      expect(genericText).not.toContain(secret);
    }
    expect(genericText).not.toMatch(/eyJ/);
    expect(of(generic.events, "secretLink")).toEqual([]);
    // The access token is still a JWT with its expiry, but no subject.
    const jwt = of(generic.events, "secret").find(
      (secret) => secret.type === "jwt",
    )!;
    expect(Object.keys(jwt.claims!).sort()).toEqual(["exp", "iat"]);
  });

  test("makes one call per mutation and HTTP call, and per query result", () => {
    const calls = of(events, "call");
    expect(calls.map((call) => `${call.transport} ${call.identifier}`)).toEqual(
      [
        "socket auth:signUpWithUsernamePassword",
        "socket auth:isAuthenticated",
        "socket currentUser:loggedInUser",
        "http auth:refreshSession",
        "http auth:signOut",
        // The results of the sign-out (signed out), in the order the socket
        // brought them.
        "socket auth:isAuthenticated",
        "socket currentUser:loggedInUser",
        "socket auth:signInWithUsernamePassword",
        "socket auth:signInWithUsernamePassword",
        "socket auth:isAuthenticated",
        "http auth:refreshSession",
        "socket currentUser:loggedInUser",
      ],
    );
  });

  test("links each mutation of the page to its run", () => {
    const timeline = mergeTimeline([...events, ...browserFixture.runs], skew);
    const runs = new Map(of(timeline, "run").map((run) => [run.id, run]));
    for (const call of of(timeline, "call")) {
      if (call.udfType === "Query") {
        // Linked, or unlinked with a reason.
        expect(call.runId !== null || call.unlinked !== null).toBe(true);
        continue;
      }
      expect(call.unlinked).toBe(null);
      expect(runs.get(call.runId!)?.identifier).toBe(call.identifier);
      expect(call.link).toBe(call.commitTs === null ? "window" : "commitTs");
    }
  });
});

describe("SocketReader", () => {
  const reader = () => {
    const secrets = new Secrets(GENERIC_BROWSER, nodeDigest);
    const calls = new CallTracker("p1");
    return new SocketReader(
      new BrowserRedactor(GENERIC_PROJECT, secrets),
      calls,
    );
  };
  const frame = (
    direction: "sent" | "received",
    message: object,
    time = 1,
  ) => ({
    pageId: "p1",
    socketId: "ws1",
    eventId: `e${time}`,
    time,
    direction,
    payload: JSON.stringify(message),
  });

  test("keeps a result that arrives after the page asked to remove the query", () => {
    const socket = reader();
    socket.read(
      frame(
        "sent",
        {
          type: "ModifyQuerySet",
          modifications: [
            { type: "Add", queryId: 0, udfPath: "q:get", args: [{}] },
          ],
        },
        1,
      ),
    );
    socket.read(
      frame(
        "sent",
        {
          type: "ModifyQuerySet",
          modifications: [{ type: "Remove", queryId: 0 }],
        },
        2,
      ),
    );
    const events = socket.read(
      frame(
        "received",
        {
          type: "Transition",
          modifications: [
            { type: "QueryUpdated", queryId: 0, value: 1, logLines: [] },
            { type: "QueryRemoved", queryId: 0 },
          ],
        },
        3,
      ),
    );
    expect(events.map((event) => event.kind)).toEqual(["socket", "call"]);
    // After the removal, the query has no more results.
    expect(
      socket.read(
        frame(
          "received",
          {
            type: "Transition",
            modifications: [{ type: "QueryUpdated", queryId: 0, value: 2 }],
          },
          4,
        ),
      ),
    ).toHaveLength(1);
  });

  test("estimates the skew from the server time of a transition", () => {
    const socket = reader();
    socket.read(
      frame(
        "received",
        { type: "Transition", serverTs: 61_000_000_000, modifications: [] },
        1000,
      ),
    );
    expect(socket.skew).toBe(60_000);
  });

  test("keeps only the keys of a message it does not know", () => {
    const [event] = reader().read(
      frame("received", { type: "Future", secret: "x" }),
    );
    expect(event).toMatchObject({
      type: "Future",
      message: { keys: ["secret"] },
    });
  });
});

describe("helpers", () => {
  test("decodes the timestamps of the sync protocol", () => {
    expect(decodeSyncTs("G6QxRwe56xg=")).toBe("1795732317347619867");
    expect(decodeSyncTs("AAAAAAAAAAA=")).toBe("0");
  });

  test("tells the HTTP API of the deployment", () => {
    expect(
      httpApiType(
        "http://127.0.0.1:3210/api/mutation",
        "http://127.0.0.1:3210",
      ),
    ).toBe("Mutation");
    expect(
      httpApiType(
        "http://localhost:5173/api/mutation",
        "http://127.0.0.1:3210",
      ),
    ).toBe(null);
  });

  test("labels the value of a cookie", () => {
    const secrets = new Secrets(GENERIC_BROWSER, nodeDigest);
    let n = 0;
    const cookie = {
      name: "session",
      value: "abc",
      domain: "app",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    };
    const set = diffCookies([], [cookie], 1, () => `c${++n}`, secrets);
    const changed = diffCookies(
      [cookie],
      [{ ...cookie, value: "def" }],
      2,
      () => `c${++n}`,
      secrets,
    );
    const removed = diffCookies([cookie], [], 3, () => `c${++n}`, secrets);
    expect(
      [set, changed, removed].map((events) =>
        events.map((e) => [e.op, e.value]),
      ),
    ).toEqual([
      [["set", { $secret: "s1" }]],
      [["change", { $secret: "s2" }]],
      [["remove", null]],
    ]);
  });

  test("never keeps the text of a password field, and keeps a username only when the project does", () => {
    const secrets = new Secrets(GENERIC_BROWSER, nodeDigest);
    const target = (type: string, name: string) => ({
      tag: "input",
      type,
      id: name,
      name,
      autocomplete: null,
      text: null,
      selector: `#${name}`,
    });
    const input = (
      project: typeof GENERIC_PROJECT,
      type: string,
      name: string,
      value: string | null,
    ) =>
      readInput(
        { action: "type", time: 1, target: target(type, name), value },
        "p1",
        "e1",
        new BrowserRedactor(project, secrets),
      ).value;
    expect(input(convexAuthProject, "password", "password", null)).toBe(null);
    expect(input(convexAuthProject, "text", "password", "hunter2")).toBe(
      REDACTED,
    );
    expect(input(convexAuthProject, "text", "username", "alice")).toBe("alice");
    expect(input(GENERIC_PROJECT, "text", "username", "alice")).toBe(REDACTED);
  });
});

describe("readPageStep", () => {
  const ids = () => {
    let n = 0;
    return () => `p1#${n++}`;
  };

  test("reads a step report of the page, with its part", () => {
    const line =
      '[explorer:step] {"v":1,"source":"convex-auth","step":"storage.write",' +
      '"runsIn":"browser","part":"module:browser/storage",' +
      '"key":"__convexAuthRefreshToken","namespace":"http1270013210"}';
    expect(readPageStep(line, "p1", ids(), 1000)).toEqual({
      kind: "step",
      from: "page",
      id: "p1#0",
      time: 1000,
      runId: null,
      pageId: "p1",
      runsIn: "browser",
      part: "module:browser/storage",
      v: 1,
      source: "convex-auth",
      step: "storage.write",
      detail: { key: "__convexAuthRefreshToken", namespace: "http1270013210" },
    });
  });

  test("takes no id for a line that is not a report", () => {
    const nextId = ids();
    expect(readPageStep("hello", "p1", nextId, 0)).toBeNull();
    expect(nextId()).toBe("p1#0");
  });

  test("scrubs a token that a report should not hold", () => {
    const jwt =
      "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMSIsImV4cCI6MX0.c2lnbmF0dXJlLW9uZQ";
    const line = `[explorer:step] {"v":1,"source":"x","step":"s","token":"${jwt}"}`;
    const event = readPageStep(line, "p1", ids(), 0);
    expect(event?.part).toBeNull();
    expect(JSON.stringify(event)).not.toContain("eyJ");
  });
});
