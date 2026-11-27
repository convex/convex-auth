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

/**
 * The parts of the vast sample (`vast/`): a world in which big things hold
 * smaller things. Positions are in metres, y up; the viewer looks toward -z.
 * A part draws itself around its base: the center of its footprint, at the
 * height it stands on.
 */
export type PlaceKind =
  /** The browser itself: the ground plate everything of the client stands on. */
  | "territory"
  /** A big thing of the browser: the page, code, a store, the connections. */
  | "district";
export type PieceKind =
  /** A source file, inside a district of code. */
  | "module"
  /** A function or value of a module. */
  | "function"
  /** An element of the page; an element can hold elements. */
  | "element"
  /** A key of a store. */
  | "key"
  /** The value of a key. */
  | "value"
  /** A claim of a token. */
  | "claim";

export type PlaceProps = {
  kind: PlaceKind;
  /** The base. */
  position: V3;
  /** Width (x), height (y), depth (z). */
  size: V3;
  /** Which district this is, so that a look can tell them apart. */
  id: string;
  active: boolean;
};
export type PieceProps = {
  kind: PieceKind;
  id: string;
  position: V3;
  size: V3;
  /** What it is called in the code; drawn on the piece. */
  label: string;
  /** A second, smaller line: a value, a path. */
  note?: string;
  active: boolean;
};
export type MonumentProps = {
  /** The center of the bottom edge of the body. */
  position: V3;
  width: number;
  height: number;
  /** The height of the bottom edge of the page above the base. */
  pageLift: number;
  pressed: boolean;
};
export type GateProps = {
  position: V3;
  width: number;
  height: number;
  label: string;
  active: boolean;
};
export type TrailProps = {
  /** The part of the route travelled so far. */
  points: Vector3[];
  kind: "request" | "response";
};
export type CarrierProps = {
  position: Vector3;
  kind: "request" | "response" | "token";
  opacity: number;
};
export type NameProps = {
  position: V3;
  text: string;
  /** Letter height in metres. */
  size: number;
  /** "place": the name of a big thing; "note": a line under it. */
  kind: "place" | "note";
  /** Painted on the ground, read from the front, or standing up. */
  flat: boolean;
};

export type WorldParts = {
  Ground: FC;
  Monument: FC<MonumentProps>;
  Place: FC<PlaceProps & { children?: ReactNode }>;
  Piece: FC<PieceProps>;
  Gate: FC<GateProps>;
  Trail: FC<TrailProps>;
  Carrier: FC<CarrierProps>;
  Name: FC<NameProps>;
};

type LookBase = {
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
};

/** A look of the small sample scene (`SampleScene.tsx`). */
export type SampleLook = LookBase & { parts: Parts };
/** A look of the vast sample (`vast/VastScene.tsx`). */
export type WorldLook = LookBase & { world: WorldParts };
export type Look = SampleLook | WorldLook;

export const isWorldLook = (look: Look): look is WorldLook => "world" in look;
