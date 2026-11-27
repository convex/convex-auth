/**
 * The look of the stage: every colour, material and light of its scene and
 * of its panels, in this one module, so that another look can replace it.
 * This one is a grey box: plain neutral materials, no glow, nothing that moves
 * for decoration. Activity is the one colour that stands out.
 *
 * @module
 */

export const LOOK = {
  /** The space around the stage. */
  background: "#d8d8d4",
  /** The ground plane, far around. */
  ground: "#cbcbc6",
  /** The floor of the browser: a raised platform. */
  platform: "#bdbdb7",
  platformEdge: "#a9a9a3",
  /** The lower step at the front, where the exits stand. */
  step: "#b1b1ab",

  /** The screen's frame and stand. */
  bezel: "#3e3e3c",
  stand: "#5a5a57",
  /** The screen when it shows no live page (in a replay). */
  screenOff: "#2f2f2d",
  screenOffText: "#bdbdb7",

  /** A thing of the browser: page, client code, storage, connections. */
  block: "#e8e8e4",
  blockSide: "#d6d6d1",
  /** A trough or tray that holds things. */
  tray: "#a3a39d",
  /** A pipe that carries messages. */
  pipe: "#9a9a94",
  /** An exit to something outside the browser. */
  exit: "#77776f",
  exitOpening: "#4a4a45",

  /** An object held in storage. */
  item: "#f4f4f1",
  /** An object that is a token (named by its secret id). */
  token: "#c9b98f",
  /** A message or request in flight. */
  message: "#f4f4f1",
  messageReceived: "#dcdcd6",
  failed: "#b5544a",

  /** What is happening now: a used element, a landing object. */
  active: "#d9822b",

  text: "#2a2a28",
  textDim: "#6b6b66",
  textOnDark: "#ecece8",

  /** The element highlight drawn on the screen. */
  highlight: "#d9822b",
} as const;

export const LIGHTS = {
  ambient: 0.75,
  /** One soft directional light from the front left, above. */
  sun: { intensity: 1.6, position: [-18, 30, 24] as [number, number, number] },
  /** A faint fill from the right. */
  fill: { intensity: 0.45, position: [20, 12, 10] as [number, number, number] },
} as const;

/** Standard material settings: matte, no metal. */
export const MATTE = { roughness: 0.92, metalness: 0 } as const;

/** The colours of the HTML panels, as CSS variables. */
export const PANEL_CSS: Record<string, string> = {
  "--stage-bg": LOOK.background,
  "--stage-panel": "rgba(250, 250, 247, 0.94)",
  "--stage-line": "rgba(40, 40, 38, 0.16)",
  "--stage-text": LOOK.text,
  "--stage-dim": LOOK.textDim,
  "--stage-active": LOOK.active,
  "--stage-track": "#c4c4bf",
  "--stage-button": "#ecece8",
  "--stage-button-on": "#2a2a28",
  "--stage-button-on-text": "#f4f4f1",
};
