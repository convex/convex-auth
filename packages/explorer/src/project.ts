/**
 * What the recorder knows about the app it records, beyond what every Convex
 * app has. The recorder works without it: a project config only adds string
 * fields to keep in the timeline. See `projects/` for the configs in this
 * package.
 *
 * @module
 */

/** Field names, by table name. */
export type FieldsByTable = Readonly<Record<string, readonly string[]>>;

/**
 * A row of the server that stores a digest of a secret that the client holds,
 * such as the hash of a refresh token. The recorder computes the digest of
 * each secret it sees in the browser and links the secret to the row with the
 * same digest, without writing either.
 */
export type SecretDigest = {
  /** The table of the row, in any component. */
  table: string;
  /** The field of the row that holds the digest. */
  field: string;
  /** How the digest is computed: the hex SHA-256 of the UTF-8 secret. */
  digest: "sha256Hex";
};

/** A claim of a JWT that holds the id of a row. */
export type ClaimLink = {
  claim: string;
  /** The table of the row, in any component. */
  table: string;
};

/**
 * What the recorder keeps of what the browser sends, receives, and stores.
 * Every string not named here is replaced, and every value that looks like a
 * token is replaced by a label of the recording, whatever the config.
 */
export type BrowserProjectConfig = {
  /**
   * Storage keys whose value is a secret, by prefix: the value gets a label
   * even when it does not look like a token.
   */
  secretStorageKeys: readonly string[];
  /**
   * Keys of the JSON values of the page (function arguments, results, query
   * results) whose strings hold no secret and no personal data, such as a
   * `status`.
   */
  safeKeys: readonly string[];
  /**
   * Keys of those values whose strings hold personal data, such as a
   * `username`. Kept only when `keepPersonalData` is true. Text that a person
   * types into a field of the page follows the same rule, by the field's
   * `name`, `id`, or `autocomplete`.
   */
  personalKeys: readonly string[];
  /**
   * String claims of a JWT that hold no secret. The numeric claims (`exp`,
   * `iat`, `nbf`) are always kept; the signature never is.
   */
  safeJwtClaims: readonly string[];
  /** See {@link SecretDigest}. */
  secretDigests: readonly SecretDigest[];
  /** See {@link ClaimLink}. */
  claimLinks: readonly ClaimLink[];
};

/** The browser config of a project that names nothing. */
export const GENERIC_BROWSER: BrowserProjectConfig = {
  secretStorageKeys: [],
  safeKeys: [],
  personalKeys: [],
  safeJwtClaims: [],
  secretDigests: [],
  claimLinks: [],
};

export type ProjectConfig = {
  /** The name of the project, in the `recording` event. */
  name: string;
  /**
   * String fields that hold no secret and no personal data, by table name.
   * The recorder keeps them. Every other string of a document is replaced,
   * except ids.
   */
  safeFields: FieldsByTable;
  /**
   * String fields that hold a URL whose origin and path are safe, by table
   * name. The recorder keeps the origin and the path, and replaces the value
   * of each query parameter and the fragment.
   */
  urlFields?: FieldsByTable;
  /**
   * String fields that hold personal data, such as usernames or email
   * addresses, by table name. The recorder keeps them only when
   * `keepPersonalData` is true.
   */
  personalFields: FieldsByTable;
  /** Whether to keep the `personalFields` and the `personalKeys`. */
  keepPersonalData: boolean;
  /** What to keep of the browser feed. Default: {@link GENERIC_BROWSER}. */
  browser?: BrowserProjectConfig;
};

/** The config for an app the recorder knows nothing about. */
export const GENERIC_PROJECT: ProjectConfig = {
  name: "generic",
  safeFields: {},
  personalFields: {},
  keepPersonalData: false,
};

/** The string fields of `table` that the project keeps. */
export function keptFields(
  project: ProjectConfig,
  table: string,
): ReadonlySet<string> {
  return new Set([
    ...(project.safeFields[table] ?? []),
    ...(project.keepPersonalData ? (project.personalFields[table] ?? []) : []),
  ]);
}

/** The URL fields of `table`. */
export function urlFields(
  project: ProjectConfig,
  table: string,
): ReadonlySet<string> {
  return new Set(project.urlFields?.[table] ?? []);
}

/** The browser config of the project, or {@link GENERIC_BROWSER}. */
export function browserConfig(project: ProjectConfig): BrowserProjectConfig {
  return project.browser ?? GENERIC_BROWSER;
}
