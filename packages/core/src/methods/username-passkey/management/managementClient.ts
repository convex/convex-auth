/**
 * The framework-agnostic clients of the passkey settings page: adding and
 * removing a passkey of the signed-in user. The React hooks of `react.tsx`
 * wrap them, and so can a binding for another framework.
 *
 * There is no list client: `listPasskeys` is a plain reactive query, and
 * `renamePasskey` a plain mutation, which a binding calls on its own Convex
 * client.
 *
 * @module
 */

import type { ReadableStore } from "../../../browser/store.ts";
import {
  createPasskeyCeremonySlot,
  type AlreadyPendingFailure,
} from "../autofill.ts";
import {
  runAddPasskeyFlow,
  runRemovePasskeyFlow,
  type AddPasskeyApi,
  type AddPasskeyFlowResult,
  type PasskeyManagementOptions,
  type RemovePasskeyApi,
  type RemovePasskeyFlowResult,
} from "./flows.ts";

export type { PasskeyManagementOptions } from "./flows.ts";

/** The result of `addPasskey` of {@link createAddPasskey}. */
export type AddPasskeyResult = AddPasskeyFlowResult | AlreadyPendingFailure;

/** The result of `removePasskey` of {@link createRemovePasskey}. */
export type RemovePasskeyResult =
  RemovePasskeyFlowResult | AlreadyPendingFailure;

/** The client of the "Add a passkey" button. */
export type AddPasskeyClient = {
  /**
   * Add a passkey to the account of the signed-in user: authenticate with an
   * existing passkey, then register the new one. Resolves to an object with
   * a `success` flag, and never rejects. When it is `false`, `userError`
   * tells why.
   */
  addPasskey: () => Promise<AddPasskeyResult>;
  /** `true` while an `addPasskey` call runs. */
  pending: ReadableStore<boolean>;
};

/** The client of the "Remove" button of a passkey list. */
export type RemovePasskeyClient = {
  /**
   * Remove the given passkey from the account of the signed-in user, after
   * the user authenticates with another passkey. Resolves to an object with
   * a `success` flag, and never rejects. When it is `false`, `userError`
   * tells why.
   */
  removePasskey: (passkeyId: string) => Promise<RemovePasskeyResult>;
  /** `true` while a `removePasskey` call runs. */
  pending: ReadableStore<boolean>;
};

/**
 * Make the client of the "Add a passkey" button. It reads its options when
 * it uses them, so a binding can pass getters.
 */
export function createAddPasskey(
  options: PasskeyManagementOptions<AddPasskeyApi>,
): AddPasskeyClient {
  // Not a log in page, so there is no autofill here.
  const slot = createPasskeyCeremonySlot({ autofill: null });
  return {
    addPasskey: () => slot.run(() => runAddPasskeyFlow(options)),
    pending: slot.pending,
  };
}

/**
 * Make the client of the "Remove" button of a passkey list. It reads its
 * options when it uses them, so a binding can pass getters.
 */
export function createRemovePasskey(
  options: PasskeyManagementOptions<RemovePasskeyApi>,
): RemovePasskeyClient {
  const slot = createPasskeyCeremonySlot({ autofill: null });
  return {
    removePasskey: (passkeyId) =>
      slot.run(() => runRemovePasskeyFlow(options, { passkeyId })),
    pending: slot.pending,
  };
}
