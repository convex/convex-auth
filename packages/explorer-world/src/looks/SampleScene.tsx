/**
 * The sample scene: a screen standing in open space with the sign-in page on
 * it, and in front of it the things of the browser. Content only: every part
 * comes from the kit and is drawn by the current look.
 */
import { useMemo } from "react";
import {
  Block,
  Container,
  Exit,
  Ground,
  Mover,
  Path,
  Screen,
  Token,
} from "./kit.tsx";
import {
  AUTH_CLIENT,
  COOKIES,
  EXIT,
  LOCAL_STORAGE,
  PAGE_CODE,
  ROUTES,
  SCREEN,
  SLOTS,
  drawnPoint,
  type RouteName,
  type V3,
} from "./layout.ts";
import { frameAt } from "./motion.ts";

const TRAVELLED: RouteName[] = ["press", "out", "store"];
const DRAWN: RouteName[] = ["code", "cookies"];

export function SampleScene({ time }: { time: number }) {
  const f = frameAt(time);
  const points = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(ROUTES).map(([k, c]) => [
          k,
          c.getSpacedPoints(64).filter(drawnPoint),
        ]),
      ) as Record<RouteName, ReturnType<typeof ROUTES.press.getSpacedPoints>>,
    [],
  );
  const slot = (i: number): V3 => [
    LOCAL_STORAGE.position[0] + SLOTS[i].offset[0],
    LOCAL_STORAGE.size[1] * 0.45,
    LOCAL_STORAGE.position[2] + SLOTS[i].offset[2],
  ];
  return (
    <>
      <Ground />
      <Screen {...SCREEN} pressed={f.pressed} />
      {[...DRAWN, ...TRAVELLED].map((r) => (
        <Path
          key={r}
          points={points[r]}
          active={f.route === r}
          travelled={TRAVELLED.includes(r)}
        />
      ))}
      {[PAGE_CODE, AUTH_CLIENT].map((t) => (
        <Block key={t.id} {...t} active={f.active === t.id} />
      ))}
      <Container {...COOKIES} active={f.active === COOKIES.id} />
      <Container {...LOCAL_STORAGE} active={f.active === LOCAL_STORAGE.id}>
        {SLOTS.map((s, i) =>
          f.tokens[i]?.settled ? (
            <Token
              key={s.label}
              position={slot(i)}
              label={s.label}
              state="held"
            />
          ) : (
            <Token
              key={s.label}
              position={slot(i)}
              label={s.label}
              state="slot"
            />
          ),
        )}
      </Container>
      <Exit {...EXIT} active={f.active === EXIT.id} />
      {f.mover && (
        <Mover
          position={f.mover.position}
          kind={f.mover.kind}
          opacity={f.mover.opacity}
        />
      )}
      {f.tokens.map(
        (t, i) =>
          t &&
          !t.settled && (
            <Token
              key={SLOTS[i].label}
              position={t.position}
              label={SLOTS[i].label}
              state="moving"
            />
          ),
      )}
    </>
  );
}
