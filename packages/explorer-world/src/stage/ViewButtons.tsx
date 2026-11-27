import { stageAt } from "./model.ts";
import { reloadPage } from "./Screen.tsx";
import { useStage } from "./store.ts";

/**
 * Face the screen squarely to use the page, and step back again; load the
 * page again, as the browser's reload button would.
 */
export function ViewButtons() {
  const view = useStage((s) => s.view);
  const fly = useStage((s) => s.fly);
  const live = useStage((s) => s.source.kind === "live");
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
      {live && (
        <button
          onClick={() => {
            const s = useStage.getState();
            reloadPage(stageAt(s.live, Date.now()).path);
          }}
          title="Load the page on the screen again"
        >
          Reload the page
        </button>
      )}
    </div>
  );
}
