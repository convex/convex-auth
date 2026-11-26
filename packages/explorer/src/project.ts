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
   * String fields that hold personal data, such as usernames or email
   * addresses, by table name. The recorder keeps them only when
   * `keepPersonalData` is true.
   */
  personalFields: FieldsByTable;
  /** Whether to keep the `personalFields`. */
  keepPersonalData: boolean;
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
