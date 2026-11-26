/**
 * Turns the pages of the data sync API (`POST /api/v1/data/sync`) into
 * events. See https://docs.convex.dev/deployment-api/data-sync.
 *
 * @module
 */
import type { WriteEvent } from "./events.ts";
import { nanosOf, nanosToMs, parseJsonLossless } from "./json.ts";
import { GENERIC_PROJECT, type ProjectConfig } from "./project.ts";
import { redactDocument } from "./redact.ts";

/** The `status` of a page. */
export type SyncStatus =
  | { type: "snapshotting" }
  | { type: "stale"; snapshotTs: string }
  | { type: "upToDate"; snapshotTs: string };

/** A table to clear before the values of the page apply. */
export type SyncTruncate = { component: string; table: string };

/** One page of the data sync, as events. */
export type SyncPage = {
  status: SyncStatus;
  syncId: string;
  /** The cursor to send for the next page. */
  nextCursor: string;
  truncates: SyncTruncate[];
  /**
   * The revisions of the page, redacted, with no run attached yet, and
   * `snapshot` false. {@link SyncReader} sets `snapshot`.
   */
  writes: WriteEvent[];
};

/**
 * The events of one page of the data sync, from the text of the response.
 *
 * Takes the text, not parsed JSON, because `JSON.parse` would round the
 * nanosecond commit times.
 */
export function parseSyncPage(
  text: string,
  project: ProjectConfig = GENERIC_PROJECT,
  observe?: ObserveDocument,
): SyncPage {
  const page = parseJsonLossless(text) as Record<string, unknown>;
  const status = parseStatus(page.status);
  const pagination = page.pagination as Record<string, unknown> | undefined;
  if (typeof pagination?.nextCursor !== "string") {
    throw new Error("The data sync page has no `pagination.nextCursor`.");
  }
  const truncates = Array.isArray(page.truncates)
    ? page.truncates.map((truncate) => {
        const { component, table } = truncate as Record<string, unknown>;
        return { component: String(component ?? ""), table: String(table) };
      })
    : [];
  const writes = Array.isArray(page.values)
    ? page.values.map((value) => writeFromValue(value, project, observe))
    : [];
  return {
    status,
    syncId: String(page.syncId ?? ""),
    nextCursor: pagination.nextCursor,
    truncates,
    writes,
  };
}

function parseStatus(value: unknown): SyncStatus {
  const status = value as Record<string, unknown> | undefined;
  if (status?.type === "snapshotting") {
    return { type: "snapshotting" };
  }
  if (status?.type === "stale" || status?.type === "upToDate") {
    const snapshotTs = nanosOf(status.snapshotTs);
    if (snapshotTs !== null) {
      return { type: status.type, snapshotTs };
    }
  }
  throw new Error(
    `The data sync page has an unknown status: ${JSON.stringify(value)}`,
  );
}

/**
 * Sees each document of the data sync before redaction, with its component,
 * table, id, and commit time in ms. Null `value` for a delete. It must not
 * keep or write what it sees, except as the recorder's links (see
 * `secrets.ts`).
 */
export type ObserveDocument = (
  component: string,
  table: string,
  documentId: string,
  value: Record<string, unknown> | null,
  time: number,
) => void;

function writeFromValue(
  entry: unknown,
  project: ProjectConfig,
  observe?: ObserveDocument,
): WriteEvent {
  const { component, table, ts, deleted, value } = entry as Record<
    string,
    unknown
  >;
  const nanos = nanosOf(ts);
  if (nanos === null || typeof table !== "string") {
    throw new Error("A data sync value has no `ts` or no `table`.");
  }
  const document = (value ?? {}) as Record<string, unknown>;
  const documentId = String(document._id ?? "");
  const componentPath = typeof component === "string" ? component : "";
  const isDelete = deleted === true;
  observe?.(
    componentPath,
    table,
    documentId,
    isDelete ? null : document,
    nanosToMs(nanos),
  );
  return {
    kind: "write",
    id: `${componentPath}/${table}/${documentId}@${nanos}`,
    time: nanosToMs(nanos),
    ts: nanos,
    component: componentPath,
    table,
    documentId,
    deleted: isDelete,
    value: isDelete ? null : redactDocument(table, document, project),
    runId: null,
    snapshot: false,
  };
}

/**
 * Reads the pages of one data sync in order, and tells the revisions of the
 * initial snapshot from the writes that happen after it.
 *
 * The snapshot holds the latest revision of each document at the time
 * `snapshotTs`, which the first page whose status is `stale` or `upToDate`
 * gives. A page can hold values of the snapshot under either status, thus a
 * revision is part of the snapshot when its `ts` is at most `snapshotTs`.
 * The reader holds the revisions back until it knows `snapshotTs`.
 */
export class SyncReader {
  private syncId: string | null = null;
  private snapshotTs: bigint | null = null;
  private held: WriteEvent[] = [];

  /** The cursor for the next request; null for the first one. */
  cursor: string | null = null;

  /** Whether the last page said that the sync caught up. */
  upToDate = false;

  constructor(
    private readonly project: ProjectConfig = GENERIC_PROJECT,
    private readonly observe?: ObserveDocument,
  ) {}

  /**
   * Reads one page. Returns the revisions that are ready, in the order of the
   * pages, and whether the page started a new sync of a table that already
   * had revisions: a truncate after the snapshot, or a new `syncId`.
   */
  read(text: string): { writes: WriteEvent[]; reset: boolean } {
    const page = parseSyncPage(text, this.project, this.observe);
    let reset = false;
    if (this.syncId !== null && page.syncId !== this.syncId) {
      reset = true;
      this.snapshotTs = null;
    }
    if (this.snapshotTs !== null && page.truncates.length > 0) {
      reset = true;
    }
    this.syncId = page.syncId;
    this.cursor = page.nextCursor;
    this.upToDate = page.status.type === "upToDate";
    this.held.push(...page.writes);
    if (this.snapshotTs === null && page.status.type !== "snapshotting") {
      this.snapshotTs = BigInt(page.status.snapshotTs);
    }
    if (this.snapshotTs === null) {
      return { writes: [], reset };
    }
    const snapshotTs = this.snapshotTs;
    const writes = this.held.map((write) => ({
      ...write,
      snapshot: BigInt(write.ts) <= snapshotTs,
    }));
    this.held = [];
    return { writes, reset };
  }
}
