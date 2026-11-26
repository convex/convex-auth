/**
 * Feeds captured from a local backend running
 * `examples/react-username-password` with step reports on: a sign-up, a
 * sign-in, two refreshes, a refresh with a spent token (reuse detection), a
 * sign-out, and a sign-in with a wrong password. The recorder started after
 * an earlier run, thus the data sync begins with a snapshot of 17 documents.
 *
 * Sanitised: each refresh token hash and password hash is a fake.
 */
import { isLogEntry, type LogEntry } from "./logs.ts";
import logsText from "./fixtures/logs.jsonl?raw";
import syncText from "./fixtures/sync-pages.ndjson?raw";

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
