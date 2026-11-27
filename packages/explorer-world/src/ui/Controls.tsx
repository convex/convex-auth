import { requestAction, useControls } from "../controls.ts";
import { idle, usePlayback } from "../store.ts";

/**
 * The controls of live mode: one button per action of the hidden page, and
 * the username in use. A button is enabled only when the recorder says its
 * action applies to the page as it is, and says why otherwise.
 */
export function Controls() {
  const live = usePlayback((s) => s.live);
  const { state, asking, error } = useControls();
  if (idle) {
    return (
      <div className="controls panel" data-testid="controls">
        <p className="hint">
          Not live. Run{" "}
          <code>pnpm explorer:live examples/react-username-password</code> and
          open the link it prints.
        </p>
      </div>
    );
  }
  if (!live) return null;
  const connected = live.connection === "open" && live.caughtUp;
  return (
    <div className="controls panel" data-testid="controls">
      <div className="who">
        {state?.username ? (
          <>
            user <span className="mono">{state.username}</span>
          </>
        ) : (
          "no user yet"
        )}
      </div>
      {state === null ? (
        <p className="hint">
          {live.connection === "ended"
            ? "The recording ended."
            : "Waiting for the recorder's page…"}
        </p>
      ) : state.actions.length === 0 ? (
        <p className="hint">This app declares no actions.</p>
      ) : (
        <ul>
          {state.actions.map((action) => {
            const running = state.busy === action.id || asking === action.id;
            const enabled =
              connected && action.enabled && asking === null && !running;
            const reason = running
              ? "running"
              : !connected
                ? "not connected"
                : action.reason;
            return (
              <li key={action.id}>
                <button
                  type="button"
                  data-action={action.id}
                  data-running={running ? "" : undefined}
                  disabled={!enabled}
                  title={reason ?? undefined}
                  onClick={() => void requestAction(action.id)}
                >
                  {action.label}
                </button>
                {reason ? <span className="reason">{reason}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
      {error ? (
        <p className="hint error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
