import { useStage } from "./store.ts";

/** Face the screen squarely to use the page, and step back again. */
export function ViewButtons() {
  const view = useStage((s) => s.view);
  const fly = useStage((s) => s.fly);
  return (
    <div className="stage-view panel">
      {view === "screen" ? (
        <button onClick={() => fly("default")} title="Back to the whole stage">
          Step back
        </button>
      ) : (
        <button
          onClick={() => fly("screen")}
          title="Stand in front of the screen, close enough to read and type"
        >
          Face the screen
        </button>
      )}
    </div>
  );
}
