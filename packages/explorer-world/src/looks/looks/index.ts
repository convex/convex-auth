import type { Look } from "../look.ts";
import { blueprint } from "./blueprint.tsx";
import { glassLook } from "./glass.tsx";
import { hardware } from "./hardware.tsx";
import { nightGlow } from "./nightGlow.tsx";
import { studio } from "./studio.tsx";
import { toy } from "./toy.tsx";

/** Every look, in the order of their keys (1, 2, ...). */
export const LOOKS: Look[] = [
  nightGlow,
  studio,
  blueprint,
  glassLook,
  toy,
  hardware,
];
