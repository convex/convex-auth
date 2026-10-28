/**
 * The OAuth flow error of each auth client. One component can complete a
 * callback while another shows the error, so the error is stored per client.
 *
 * @module
 */
import type { AuthClient } from "../../browser/sessionManager.ts";
import type { OauthFlowError } from "./client.ts";

type FlowState = {
  error: OauthFlowError | null;
  listeners: Set<() => void>;
};

const states = new WeakMap<AuthClient, FlowState>();

function stateOf(auth: AuthClient): FlowState {
  let state = states.get(auth);
  if (state === undefined) {
    state = { error: null, listeners: new Set() };
    states.set(auth, state);
  }
  return state;
}

/** The last OAuth flow error of `auth`, or null. */
export function getOauthFlowError(auth: AuthClient): OauthFlowError | null {
  return states.get(auth)?.error ?? null;
}

/** Set the OAuth flow error of `auth` and notify its listeners. */
export function setOauthFlowError(
  auth: AuthClient,
  error: OauthFlowError | null,
): void {
  const state = stateOf(auth);
  state.error = error;
  for (const listener of state.listeners) listener();
}

/**
 * Call `listener` each time the OAuth flow error of `auth` is set. Returns a
 * function that removes the listener.
 */
export function subscribeOauthFlowError(
  auth: AuthClient,
  listener: () => void,
): () => void {
  const state = stateOf(auth);
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}
