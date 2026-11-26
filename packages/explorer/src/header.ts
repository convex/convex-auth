/**
 * The first line of a timeline: {@link RecordingEvent}.
 *
 * @module
 */
import { TIMELINE_VERSION, type RecordingEvent } from "./events.ts";

/**
 * The default name of the app at `appDir`: the last segment of the path,
 * e.g. "react-username-password" for `examples/react-username-password`.
 */
export function defaultAppName(appDir: string): string {
  const segments = appDir.split(/[\\/]+/).filter((segment) => segment !== "");
  return segments.at(-1) ?? appDir;
}

/** The `recording` event of a recording that starts at `time`. */
export function recordingHeader(options: {
  time: number;
  app: string;
  deploymentUrl: string;
  project: string;
  page: string | null;
  scenario: string | null;
}): RecordingEvent {
  return {
    kind: "recording",
    v: TIMELINE_VERSION,
    time: options.time,
    app: options.app,
    deploymentUrl: options.deploymentUrl,
    project: options.project,
    ...(options.page === null
      ? {}
      : {
          page: options.page,
          ...(options.scenario === null ? {} : { scenario: options.scenario }),
        }),
  };
}
