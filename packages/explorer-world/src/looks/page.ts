/**
 * The sign-in page of `examples/react-username-password`, drawn on a canvas
 * in the style of a look: "Log in", a username and a password field, the
 * button, and the link to sign up. Its layout is `PAGE`, so the motion
 * leaves from where the button is.
 */
import { CanvasTexture, SRGBColorSpace } from "three";
import { PAGE, SCREEN } from "./layout.ts";
import type { PageStyle } from "./look.ts";

const W = 2048;
const H = Math.round((W * SCREEN.height) / SCREEN.width);

function draw(g: CanvasRenderingContext2D, s: PageStyle, pressed: boolean) {
  const stroke = s.stroke ?? 3;
  const caps = (t: string) => (s.caps ? t.toUpperCase() : t);
  g.clearRect(0, 0, W, H);
  g.fillStyle = s.background;
  g.fillRect(0, 0, W, H);
  if (s.linesOnly) {
    g.strokeStyle = s.muted;
    g.lineWidth = stroke;
    g.strokeRect(stroke * 4, stroke * 4, W - stroke * 8, H - stroke * 8);
  }
  g.textBaseline = "middle";
  g.textAlign = "center";
  g.fillStyle = s.text;
  g.font = `700 ${Math.round(H * 0.075)}px ${s.font}`;
  g.fillText(caps("Log in"), PAGE.title.x * W, PAGE.title.y * H);

  const field = (f: typeof PAGE.username, label: string, value: string) => {
    const x = f.x * W;
    const y = f.y * H;
    const w = f.w * W;
    const h = f.h * H;
    g.textAlign = "left";
    g.fillStyle = s.muted;
    g.font = `500 ${Math.round(H * 0.032)}px ${s.font}`;
    g.fillText(caps(label), x, y - h * 0.42);
    if (!s.linesOnly) {
      g.fillStyle = s.field;
      g.fillRect(x, y, w, h);
    }
    g.strokeStyle = s.fieldBorder;
    g.lineWidth = stroke;
    g.strokeRect(x, y, w, h);
    g.fillStyle = s.text;
    g.font = `400 ${Math.round(H * 0.038)}px ${s.font}`;
    g.fillText(value, x + h * 0.3, y + h / 2);
  };
  field(PAGE.username, "Username", "ada");
  field(PAGE.password, "Password", "•".repeat(10));

  const b = PAGE.button;
  const bx = b.x * W;
  const by = b.y * H;
  const bw = b.w * W;
  const bh = b.h * H;
  if (s.linesOnly) {
    g.strokeStyle = pressed ? s.buttonPressed : s.button;
    g.lineWidth = stroke * (pressed ? 2.5 : 1.5);
    g.strokeRect(bx, by, bw, bh);
  } else {
    g.fillStyle = pressed ? s.buttonPressed : s.button;
    g.fillRect(bx, by, bw, bh);
  }
  g.textAlign = "center";
  g.fillStyle = s.buttonText;
  g.font = `700 ${Math.round(H * 0.04)}px ${s.font}`;
  g.fillText(caps("Log in"), bx + bw / 2, by + bh / 2);

  g.font = `400 ${Math.round(H * 0.03)}px ${s.font}`;
  const a = caps("Don't have an account? ");
  const l = caps("Sign up");
  const aw = g.measureText(a).width;
  const lw = g.measureText(l).width;
  const x0 = PAGE.footer.x * W - (aw + lw) / 2;
  g.textAlign = "left";
  g.fillStyle = s.muted;
  g.fillText(a, x0, PAGE.footer.y * H);
  g.fillStyle = s.link;
  g.fillText(l, x0 + aw, PAGE.footer.y * H);
}

/**
 * The page as a texture. It is drawn again once the page's fonts load, and
 * `onRedraw` is called then, to draw a frame.
 */
export function pageTexture(
  style: PageStyle,
  pressed: boolean,
  onRedraw: () => void,
): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d")!;
  draw(g, style, pressed);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  void document.fonts.ready.then(() => {
    draw(g, style, pressed);
    texture.needsUpdate = true;
    onRedraw();
  });
  return texture;
}
