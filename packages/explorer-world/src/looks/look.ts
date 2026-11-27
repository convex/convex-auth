/**
 * What a look is: everything about appearance, and nothing about content.
 * The sample scene (`SampleScene.tsx`) says what stands where and what moves;
 * a look says how each kind of thing is drawn, and the light, sky and effects
 * around them. A look is one file under `looks/`.
 */
import type { FC, ReactNode } from "react";
import type { ToneMapping, Vector3 } from "three";
import type { V3 } from "./layout.ts";

/** The things of the browser, by role. */
export type ScreenProps = {
  position: V3;
  width: number;
  height: number;
  /** Whether the button of the page is pressed. */
  pressed: boolean;
};
export type BlockProps = {
  position: V3;
  size: V3;
  label: string;
  /** The motion is at this thing. */
  active: boolean;
};
export type ContainerProps = BlockProps & { children?: ReactNode };
export type ExitProps = {
  position: V3;
  width: number;
  height: number;
  rotationY: number;
  label: string;
  active: boolean;
};
export type TokenProps = {
  position: Vector3 | V3;
  label: string;
  /** "slot": where a token will be, before it is there. */
  state: "slot" | "moving" | "held";
};
export type PathProps = {
  points: Vector3[];
  /** The motion is on this path. */
  active: boolean;
  /** A path the motion takes, as opposed to a relation that is only drawn. */
  travelled: boolean;
};
export type MoverProps = {
  position: Vector3;
  kind: "request" | "response";
  opacity: number;
};
export type LabelProps = {
  position: V3;
  text: string;
  kind: "name" | "note";
};

export type Parts = {
  Ground: FC;
  Screen: FC<ScreenProps>;
  Block: FC<BlockProps>;
  Container: FC<ContainerProps>;
  Exit: FC<ExitProps>;
  Token: FC<TokenProps>;
  Path: FC<PathProps>;
  Mover: FC<MoverProps>;
  Label: FC<LabelProps>;
};

/** How the sign-in page on the screen is drawn. */
export type PageStyle = {
  background: string;
  text: string;
  muted: string;
  field: string;
  fieldBorder: string;
  button: string;
  buttonText: string;
  /** The button while it is pressed. */
  buttonPressed: string;
  link: string;
  font: string;
  /** Draw outlines only, no fills (a line drawing). */
  linesOnly?: boolean;
  /** Line width of borders, in page pixels (of 2048 across). */
  stroke?: number;
  /** Text in capitals, as on a drawing. */
  caps?: boolean;
};

export type Look = {
  id: string;
  name: string;
  /** One line: what makes it its own direction. */
  summary: string;
  /** Whether the HTML chrome over it should be light or dark. */
  chrome: "light" | "dark";
  gl: {
    toneMapping: ToneMapping;
    exposure: number;
    shadows: boolean;
  };
  page: PageStyle;
  /** Sky, fog and light. */
  Stage: FC;
  /**
   * Post effects, or null for none. A look with bloom or any half-float
   * buffer puts `SanitizePass` first (see `../scene/safety.ts`).
   */
  Effects: FC | null;
  parts: Parts;
};
