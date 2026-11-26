/**
 * Follows tokens without writing them.
 *
 * The browser feed sees raw tokens (the access token on the socket, the
 * refresh token in storage) and the data sync sees the raw digests that the
 * server stores of them. {@link Secrets} gives each raw token a label of the
 * recording, keeps the safe claims of a JWT, and links a label to the row
 * whose digest matches, or whose id a claim holds. Only labels and links
 * reach the timeline; the raw values stay in memory.
 *
 * @module
 */
import type { SecretEvent, SecretLinkEvent, SecretRef } from "./events.ts";
import type { BrowserProjectConfig, SecretDigest } from "./project.ts";
import { scrubValue } from "./redact.ts";

/** Computes a digest of a raw secret. */
export type DigestFunction = (
  digest: SecretDigest["digest"],
  value: string,
) => string;

/** The numeric claims of a JWT that every timeline keeps. */
const NUMERIC_CLAIMS = ["exp", "iat", "nbf"];
const HEADER_FIELDS = ["alg", "typ", "kid"];

const JWT = /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/** Whether `value` is a JSON Web Token. */
export function isJwt(value: string): boolean {
  return JWT.test(value) && decodeJwt(value) !== null;
}

function base64UrlJson(segment: string): Record<string, unknown> | null {
  try {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const text = new TextDecoder().decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    );
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The header and the claims of a JWT, or null. The signature is dropped. */
export function decodeJwt(
  token: string,
): { header: Record<string, unknown>; claims: Record<string, unknown> } | null {
  const [header, claims] = token.split(".");
  const decodedHeader = base64UrlJson(header ?? "");
  const decodedClaims = base64UrlJson(claims ?? "");
  return decodedHeader === null || decodedClaims === null
    ? null
    : { header: decodedHeader, claims: decodedClaims };
}

/**
 * The claims of a JWT that a timeline keeps: the numeric `exp`, `iat`, and
 * `nbf`, and the string claims in `safeClaims`. Each kept string is scrubbed
 * all the same.
 */
export function safeClaims(
  claims: Record<string, unknown>,
  safe: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(claims)) {
    if (NUMERIC_CLAIMS.includes(name) && typeof value === "number") {
      out[name] = value;
    } else if (safe.includes(name) && typeof value === "string") {
      out[name] = scrubValue(value);
    }
  }
  return out;
}

type Row = { component: string; table: string; documentId: string };

/** Labels the secrets of a recording and links them to rows. */
export class Secrets {
  private readonly labels = new Map<string, string>();
  /** When each label was first seen. */
  private readonly seenAt = new Map<string, number>();
  /** `<digest kind>:<digest>` → the label of the secret. */
  private readonly labelByDigest = new Map<string, string>();
  /** `<digest kind>:<digest>` → the row that stores it. */
  private readonly rowByDigest = new Map<string, Row>();
  /** Document id → its row, for the tables that claims point at. */
  private readonly rowById = new Map<string, Row>();
  /** Claim value → the secrets whose claim names it. */
  private readonly claimants = new Map<
    string,
    { label: string; claim: string; table: string }[]
  >();
  private readonly linked = new Set<string>();
  private events: (SecretEvent | SecretLinkEvent)[] = [];
  private next = 1;

  constructor(
    private readonly config: BrowserProjectConfig,
    private readonly digest: DigestFunction,
    /**
     * Called with each raw secret the first time it is seen, and with each
     * raw digest the data feed holds. For checks that look for raw values in
     * a timeline; it must not write them anywhere.
     */
    private readonly onRaw?: (value: string) => void,
  ) {}

  /**
   * The label of a raw secret, seen at `time` in the event `seenIn`. The
   * first sighting makes a {@link SecretEvent}.
   */
  ref(raw: string, time: number, seenIn: string): SecretRef {
    const known = this.labels.get(raw);
    if (known !== undefined) {
      return { $secret: known };
    }
    const label = `s${this.next++}`;
    this.labels.set(raw, label);
    this.seenAt.set(label, time);
    this.onRaw?.(raw);
    const jwt = JWT.test(raw) ? decodeJwt(raw) : null;
    this.events.push({
      kind: "secret",
      id: label,
      time,
      type: jwt === null ? "opaque" : "jwt",
      firstSeenIn: seenIn,
      claims:
        jwt === null ? null : safeClaims(jwt.claims, this.config.safeJwtClaims),
      header:
        jwt === null
          ? null
          : (scrubValue(
              Object.fromEntries(
                HEADER_FIELDS.filter((name) => name in jwt.header).map(
                  (name) => [name, jwt.header[name]],
                ),
              ),
            ) as Record<string, unknown>),
    });
    for (const spec of this.config.secretDigests) {
      const key = `${spec.digest}:${this.digest(spec.digest, raw)}`;
      this.labelByDigest.set(key, label);
      const row = this.rowByDigest.get(key);
      if (row !== undefined) {
        this.link(label, row, `${spec.digest}:${spec.field}`, time);
      }
    }
    if (jwt !== null) {
      for (const { claim, table } of this.config.claimLinks) {
        const value = jwt.claims[claim];
        if (typeof value !== "string") {
          continue;
        }
        const row = this.rowById.get(value);
        if (row !== undefined && row.table === table) {
          this.link(label, row, `claim:${claim}`, time);
        } else {
          const list = this.claimants.get(value) ?? [];
          list.push({ label, claim, table });
          this.claimants.set(value, list);
        }
      }
    }
    return { $secret: label };
  }

  /**
   * A raw document of the data feed, before redaction, written at `time`.
   * Null `value` for a delete.
   */
  observeDocument(
    component: string,
    table: string,
    documentId: string,
    value: Record<string, unknown> | null,
    time: number,
  ): void {
    const row = { component, table, documentId };
    if (this.config.claimLinks.some((link) => link.table === table)) {
      this.rowById.set(documentId, row);
      for (const claimant of this.claimants.get(documentId) ?? []) {
        if (claimant.table === table) {
          this.link(claimant.label, row, `claim:${claimant.claim}`, time);
        }
      }
    }
    if (value === null) {
      return;
    }
    for (const spec of this.config.secretDigests) {
      const stored = spec.table === table ? value[spec.field] : undefined;
      if (typeof stored !== "string") {
        continue;
      }
      this.onRaw?.(stored);
      const key = `${spec.digest}:${stored}`;
      this.rowByDigest.set(key, row);
      const label = this.labelByDigest.get(key);
      if (label !== undefined) {
        this.link(label, row, `${spec.digest}:${spec.field}`, time);
      }
    }
  }

  /** The events made since the last call. */
  drain(): (SecretEvent | SecretLinkEvent)[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  private link(label: string, row: Row, via: string, time: number): void {
    const id = `${label}->${row.component}/${row.table}/${row.documentId}`;
    if (this.linked.has(id)) {
      return;
    }
    this.linked.add(id);
    this.events.push({
      kind: "secretLink",
      id,
      time: Math.max(time, this.seenAt.get(label) ?? time),
      secret: label,
      via,
      ...row,
    });
  }
}
