/**
 * Feeds captured from a local backend running
 * `examples/react-username-password` with step reports on: a sign-up, a
 * sign-in, two refreshes, a refresh with a spent token (reuse detection), a
 * sign-out, and a sign-in with a wrong password. The recorder started after
 * earlier runs, thus the data sync begins with a snapshot of 52 documents,
 * the last of them on a page whose status is already `stale`.
 *
 * Sanitised: each refresh token hash and password hash is a fake.
 */
import {
  BrowserRedactor,
  CallTracker,
  readHttp,
  readStorage,
  SocketReader,
  type HttpExchange,
} from "./browser.ts";
import type { TimelineEvent } from "./events.ts";
import browserText from "./fixtures/browser-session.json?raw";
import logsText from "./fixtures/logs.jsonl?raw";
import syncText from "./fixtures/sync-pages.ndjson?raw";
import { isLogEntry, type LogEntry } from "./logs.ts";
import { nodeDigest } from "./nodeDigest.ts";
import type { ProjectConfig } from "./project.ts";
import { Secrets } from "./secrets.ts";

/** The entries of `npx convex logs --jsonl --success`, in order. */
export const logEntries: LogEntry[] = logsText
  .trim()
  .split("\n")
  .map((line) => {
    const entry: unknown = JSON.parse(line);
    if (!isLogEntry(entry)) {
      throw new Error("The log fixture holds a line that is not an entry.");
    }
    return entry;
  });

/** The text of each response of the data sync, in order. */
export const syncPages: string[] = syncText.trim().split("\n");

/**
 * What a browser showed the recorder during a session of
 * `examples/react-username-password` on a local backend: sign up, sign out,
 * sign in with a wrong password, sign in. The raw socket frames, the calls
 * of the HTTP API with their bodies, and the storage changes, in the order
 * they came; the raw rows of `refreshTokens` and `sessions` that the data
 * sync held at the end (the rows of the first session were deleted at its
 * sign-out); and the runs and steps of the logs, as the recorder wrote them.
 *
 * Sanitised: each JWT keeps its claims under a fake signature and key id,
 * each refresh token is a fake, and each hash is the SHA-256 of the fake
 * token. The passwords are the ones the capture typed:
 * {@link FIXTURE_PASSWORDS}.
 */
export const browserFixture = JSON.parse(browserText) as {
  inputs: BrowserInput[];
  documents: {
    component: string;
    table: string;
    documentId: string;
    value: Record<string, unknown> | null;
  }[];
  runs: TimelineEvent[];
};

/** The passwords typed in {@link browserFixture}. */
export const FIXTURE_PASSWORDS = [
  "fixture password 0123",
  "wrong password 0123",
];

/** The URL of the deployment of {@link browserFixture}. */
export const FIXTURE_DEPLOYMENT = "http://127.0.0.1:3210";

export type BrowserInput =
  | {
      type: "frame";
      socketId: string;
      time: number;
      direction: "sent" | "received";
      payload: string;
    }
  | ({ type: "http" } & Omit<HttpExchange, "pageId" | "eventId">)
  | {
      type: "storage";
      time: number;
      op: "set" | "remove";
      key: string;
      value: string | null;
      oldValue: string | null;
    };

/**
 * The events that the recorder makes of {@link browserFixture}, the way
 * `browserRecorder.ts` feeds the pure modules, with the documents observed
 * at the end. Also returns the raw secrets that {@link Secrets} saw.
 */
export function replayBrowserFixture(project: ProjectConfig): {
  events: TimelineEvent[];
  rawSecrets: string[];
  skew: number;
} {
  const rawSecrets: string[] = [];
  const secrets = new Secrets(
    project.browser ?? {
      secretStorageKeys: [],
      safeKeys: [],
      personalKeys: [],
      safeJwtClaims: [],
      secretDigests: [],
      claimLinks: [],
    },
    nodeDigest,
    (value) => rawSecrets.push(value),
  );
  const redactor = new BrowserRedactor(project, secrets);
  const calls = new CallTracker("p1");
  const reader = new SocketReader(redactor, calls);
  const events: TimelineEvent[] = [];
  let n = 0;
  for (const input of browserFixture.inputs) {
    const eventId = `p1#${++n}`;
    if (input.type === "frame") {
      events.push(...reader.read({ ...input, pageId: "p1", eventId }));
    } else if (input.type === "http") {
      events.push(
        ...readHttp(
          { ...input, pageId: "p1", eventId },
          FIXTURE_DEPLOYMENT,
          redactor,
          calls,
        ),
      );
    } else {
      events.push(
        readStorage(
          {
            ...input,
            pageId: "p1",
            eventId,
            area: "local",
            origin: "http://localhost:5173",
          },
          redactor,
        ),
      );
    }
    events.push(...secrets.drain());
  }
  const end = browserFixture.inputs.at(-1)!.time;
  for (const document of browserFixture.documents) {
    secrets.observeDocument(
      document.component,
      document.table,
      document.documentId,
      document.value,
      end,
    );
  }
  events.push(...secrets.drain());
  return { events, rawSecrets, skew: reader.skew ?? 0 };
}
