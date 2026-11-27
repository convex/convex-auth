/**
 * The name of the frame that shows the app's page. The recorder
 * (`@convex-dev/explorer`, `--stage`) records the frame of this name, and only
 * it.
 */
export const SCREEN_FRAME = "explorer-screen";

/**
 * The URL of the app's page from `?screen=`, which must be on this machine
 * and on the same site as the stage (`localhost`), so that the page runs in
 * the stage's process with first-party storage and cookies. Null when
 * absent; throws when not allowed.
 */
export function screenUrl(param: string | null, stage: Location): URL | null {
  if (param === null) return null;
  const url = new URL(param, stage.href);
  if (url.protocol !== "http:" || url.hostname !== stage.hostname)
    throw new Error(
      `?screen= must be the app's page on ${stage.hostname}, such as http://${stage.hostname}:5173, not ${param}.`,
    );
  return url;
}
