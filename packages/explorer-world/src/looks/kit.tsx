/**
 * The kit the sample scene is written in: one component per kind of thing.
 * Each draws itself the way the current look says; the scene names no
 * colour and no material.
 */
import { Text } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import {
  createContext,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  type ComponentProps,
} from "react";
import type {
  BlockProps,
  ContainerProps,
  ExitProps,
  LabelProps,
  Look,
  MoverProps,
  PageStyle,
  PathProps,
  ScreenProps,
  TokenProps,
} from "./look.ts";
import { pageTexture } from "./page.ts";
import { CanvasTexture, SRGBColorSpace } from "three";
import { FONT, FONT_BOLD, FONT_MONO } from "../scene/fonts.ts";
import { glyphSafe } from "../scene/Label.tsx";

const LookContext = createContext<Look | null>(null);
export const LookProvider = LookContext.Provider;

export function useLook(): Look {
  const look = useContext(LookContext);
  if (!look) throw new Error("A part of the kit is drawn outside a look.");
  return look;
}

export const Ground = () => {
  const { Ground } = useLook().parts;
  return <Ground />;
};
export const Screen = (p: ScreenProps) => {
  const { Screen } = useLook().parts;
  return <Screen {...p} />;
};
export const Block = (p: BlockProps) => {
  const { Block } = useLook().parts;
  return <Block {...p} />;
};
export const Container = (p: ContainerProps) => {
  const { Container } = useLook().parts;
  return <Container {...p} />;
};
export const Exit = (p: ExitProps) => {
  const { Exit } = useLook().parts;
  return <Exit {...p} />;
};
export const Token = (p: TokenProps) => {
  const { Token } = useLook().parts;
  return <Token {...p} />;
};
export const Path = (p: PathProps) => {
  const { Path } = useLook().parts;
  return <Path {...p} />;
};
export const Mover = (p: MoverProps) => {
  const { Mover } = useLook().parts;
  return <Mover {...p} />;
};
export const Label = (p: LabelProps) => {
  const { Label } = useLook().parts;
  return <Label {...p} />;
};

// Helpers for the looks.

/** A vertical gradient behind everything, from the top of the view down. */
export function GradientSky({ top, bottom }: { top: string; bottom: string }) {
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 4;
    canvas.height = 256;
    const g = canvas.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, top);
    grad.addColorStop(1, bottom);
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 256);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    scene.background = texture;
    return () => {
      // The next look may have set its own already.
      if (scene.background === texture) scene.background = null;
      texture.dispose();
    };
  }, [scene, top, bottom]);
  return null;
}

/** The sign-in page in a look's style, pressed or not. */
export function usePage(style: PageStyle, pressed: boolean) {
  const invalidate = useThree((s) => s.invalidate);
  const textures = useMemo(
    () => ({
      up: pageTexture(style, false, invalidate),
      down: pageTexture(style, true, invalidate),
    }),
    [style, invalidate],
  );
  useEffect(
    () => () => {
      textures.up.dispose();
      textures.down.dispose();
    },
    [textures],
  );
  return pressed ? textures.down : textures.up;
}

type TextProps = Omit<ComponentProps<typeof Text>, "font" | "children"> & {
  children: string;
  weight?: "regular" | "bold" | "mono";
};

/** 3D text in a bundled font: troika never fetches one. */
export function Words({ children, weight = "regular", ...props }: TextProps) {
  return (
    <Suspense fallback={null}>
      <Text
        font={
          weight === "bold" ? FONT_BOLD : weight === "mono" ? FONT_MONO : FONT
        }
        anchorX="center"
        anchorY="middle"
        {...props}
      >
        {glyphSafe(children)}
      </Text>
    </Suspense>
  );
}
