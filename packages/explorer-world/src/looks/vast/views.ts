/**
 * The levels of the vast sample, each composed to be looked at from where
 * the camera is put: the whole thing far out, inside one big thing, close on
 * one small thing; and the browser with the screen looming, where it starts.
 */
import type { V3 } from "../layout.ts";

export type View = {
  id: string;
  name: string;
  key: string;
  position: V3;
  target: V3;
  /** The time the motion is moved to, if it is earlier: what the level shows. */
  atLeast?: number;
};

export const VIEWS: View[] = [
  {
    id: "far",
    name: "Far out",
    key: "f",
    position: [-1500, 1050, 2600],
    target: [0, 40, 60],
  },
  {
    id: "browser",
    name: "Browser",
    key: "b",
    position: [0, 120, 250],
    target: [0, 85, -260],
  },
  {
    id: "authClient",
    name: "Inside the Auth client",
    key: "a",
    position: [42, 104, 8],
    target: [42, 0, -126],
  },
  {
    id: "jwt",
    name: "Close on the JWT",
    key: "j",
    position: [-272, 30, -98],
    target: [-272, 4, -134],
    atLeast: 10.5,
  },
];

export const START = VIEWS[1];
