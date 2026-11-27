/**
 * The recorder's controls: which actions the hidden page can take now, and
 * the request for one.
 *
 * The recorder sends the state of its controls on the live stream (an
 * `actions` message) after each change; it decides what is enabled from what
 * it observes in the page. The world only shows that state and posts the id
 * of the action the viewer pressed to `/action` on the recorder's port, with
 * the token of the run (see `packages/explorer/src/stream.ts`).
 *
 * @module
 */
import { create } from "zustand";

/** What the page was observed to be in. */
export interface ObservedPage {
  signedIn: boolean | null;
  loading: boolean;
  page: string;
}

/** One button. */
export interface ControlState {
  id: string;
  label: string;
  enabled: boolean;
  /** Why it is disabled, or null. */
  reason: string | null;
}

/** The state the recorder sends. */
export interface ControlsState {
  busy: string | null;
  username: string | null;
  observed: ObservedPage;
  actions: ControlState[];
  /** Why there are no actions, when there are none. */
  note?: string;
}

interface ControlsStore {
  /** Null until the recorder sent its controls. */
  state: ControlsState | null;
  /** The action asked for and not yet started by the recorder. */
  asking: string | null;
  /** Why the last request failed, or null. */
  error: string | null;
}

export const useControls = create<ControlsStore>(() => ({
  state: null,
  asking: null,
  error: null,
}));

/** Takes a state from the stream; ignores what does not look like one. */
export function takeControls(value: unknown): void {
  const v = value as ControlsState | null;
  if (
    typeof v !== "object" ||
    v === null ||
    !Array.isArray(v.actions) ||
    !v.actions.every(
      (a) =>
        typeof a?.id === "string" &&
        typeof a.label === "string" &&
        typeof a.enabled === "boolean",
    )
  )
    return;
  useControls.setState({ state: v });
}

/** Where actions are posted, and with which token; set by the store. */
let endpoint: { url: URL; token: string | null } | null = null;

export function setActionEndpoint(stream: URL, token: string | null): void {
  endpoint = { url: new URL("/action", stream), token };
}

/** Asks the recorder for the action `id`. */
export async function requestAction(id: string): Promise<void> {
  if (endpoint === null) return;
  useControls.setState({ asking: id, error: null });
  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(endpoint.token === null
          ? {}
          : { "X-Explorer-Token": endpoint.token }),
      },
      body: JSON.stringify({ id }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        refused?: string;
        error?: string;
      };
      useControls.setState({
        error: `The recorder did not start it: ${body.refused ?? body.error ?? `HTTP ${response.status}`}.`,
      });
    }
  } catch (error) {
    useControls.setState({
      error: `The recorder cannot be reached (${error instanceof Error ? error.message : String(error)}).`,
    });
  } finally {
    useControls.setState({ asking: null });
  }
}
