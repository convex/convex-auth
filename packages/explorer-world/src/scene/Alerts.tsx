import { useMemo } from "react";
import { currentState, usePlayback } from "../store.ts";
import { anchorPosition } from "./look.ts";
import { TONE_COLORS } from "./palette.ts";
import { Tag } from "./Tag.tsx";

/** The log lines raised now, over the part that logged them. */
export function Alerts() {
  const key = usePlayback((s) => {
    void s.time;
    return currentState()
      .alerts.map((a) => `${a.run}:${a.start}`)
      .join(",");
  });
  const alerts = useMemo(() => {
    void key;
    return currentState().alerts;
  }, [key]);
  return (
    <>
      {alerts.map((a) => {
        const at = anchorPosition(a.part);
        const color =
          a.level === "ERROR"
            ? TONE_COLORS.error
            : a.level === "WARN"
              ? TONE_COLORS.warn
              : TONE_COLORS.normal;
        return (
          <Tag
            key={`${a.run}:${a.start}`}
            position={[at.x, at.y + 4.5, at.z]}
            color={color}
          >
            <b>{a.level}</b> · {a.text}
          </Tag>
        );
      })}
    </>
  );
}
