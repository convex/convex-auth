/**
 * The OAuth flow error of each auth client. One component can complete a
 * callback while another shows the error, so the error is stored per client,
 * with the name of the provider whose flow failed.
 *
 * @module
 */
import type { AuthClient } from "../../browser/sessionManager.ts";
import type { OauthFlowError } from "./client.ts";

type FlowState = {
  error: OauthFlowError | null;
  /** The provider of the failed flow, or null when no saved flow names it. */
  providerName: string | null;
  listeners: Set<() => void>;
};

const states = new WeakMap<AuthClient, FlowState>();

function stateOf(auth: AuthClient): FlowState {
  let state = states.get(auth);
  if (state === undefined) {
    state = { error: null, providerName: null, listeners: new Set() };
    states.set(auth, state);
  }
  return state;
}

/**
 * The last OAuth flow error of `auth`, or null. With `providerName`, it is
 * the error of that provider's flow, or of a flow that names no provider.
 */
export function getOauthFlowError(
  auth: AuthClient,
  providerName?: string,
): OauthFlowError | null {
  const state = states.get(auth);
  if (state === undefined) {
    return null;
  }
  if (
    providerName !== undefined &&
    state.providerName !== null &&
    state.providerName !== providerName
  ) {
    return null;
  }
  return state.error;
}

/**
 * Set the OAuth flow error of `auth` and notify its listeners. `providerName`
 * is the provider of the failed flow, or null when no saved flow names it.
 */
export function setOauthFlowError(
  auth: AuthClient,
  error: OauthFlowError | null,
  providerName: string | null = null,
): void {
  const state = stateOf(auth);
  state.error = error;
  state.providerName = providerName;
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
