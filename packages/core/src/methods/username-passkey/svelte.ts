/**
 * Svelte client for the `usernamePasskey` method, exported at
 * `@convex-dev/auth/methods/username-passkey/svelte`: the counterpart of
 * `@convex-dev/auth/methods/username-passkey/react`.
 *
 * {@link useSignInWithUsernamePasskey} drives the login form: the
 * identifier-first flow (a free username creates an account with a new
 * passkey, a known one asks for its passkey) and passkey autofill, where the
 * user picks an account straight from the autocompletion list of the
 * username field. {@link useAddPasskey} and {@link useRemovePasskey} drive the
 * passkey settings of a signed-in user. Listing and renaming passkeys are a
 * plain query and mutation (`api.auth.listPasskeys`, `api.auth.renamePasskey`)
 * that you call with `convex-svelte`.
 *
 * Call every helper during component initialization. Read `pending` and the
 * `autofill` fields from the returned objects (don't destructure them), so
 * they stay reactive.
 *
 * Under SvelteKit, add `finishSignUpWithUsernamePasskey` and
 * `finishSignInWithUsernamePasskey` to the `signIn` list of
 * `setupConvexAuthServer`. The other functions run on the Convex client and
 * aren't listed.
 *
 * The helpers wrap the framework-agnostic clients of
 * `@convex-dev/auth/methods/username-passkey/browser`.
 *
 * @module
 */

import { onMount } from "svelte";
import { getConvexAuthContext } from "../../svelte/client.svelte.ts";
import { fromReadableStore } from "../../svelte/store.ts";
import type { PasskeyAutofillStatus } from "./autofill.ts";
import { browserCeremonies } from "./client.ts";
import type {
  UsernamePasskeyApi,
  UsernamePasskeyAutofillError,
} from "./flows.ts";
import {
  createAddPasskey,
  createRemovePasskey,
  type AddPasskeyResult,
  type RemovePasskeyResult,
} from "./management/managementClient.ts";
import type { AddPasskeyApi, RemovePasskeyApi } from "./management/flows.ts";
import {
  createSignInWithUsernamePasskey,
  type SignInWithUsernamePasskeyResult,
} from "./signInClient.ts";

export type {
  AlreadyPendingFailure,
  PasskeyAutofillStatus,
} from "./autofill.ts";
export type { PasskeyClientError, PasskeyClientFailure } from "./ceremonies.ts";
export type {
  WireAuthenticationResponse,
  WireCreationOptions,
  WireRegistrationResponse,
  WireRequestOptions,
} from "./client.ts";
export type {
  UsernamePasskeyApi,
  UsernamePasskeyAutofillError,
} from "./flows.ts";
export type { AddPasskeyApi, RemovePasskeyApi } from "./management/flows.ts";
export type { ListPasskeysResult } from "./management/list.ts";
export type {
  AddPasskeyResult,
  RemovePasskeyResult,
} from "./management/managementClient.ts";
export type { RenamePasskeyResult } from "./management/rename.ts";
export type { SignInWithUsernamePasskeyResult } from "./signInClient.ts";

/**
 * The login form of the username + passkey method. Call it during component
 * initialization.
 *
 * While the component is mounted, the browser also offers the stored
 * passkeys in the autocompletion list of the username field, which must
 * carry `autocomplete="username webauthn"`. Picking one signs in directly.
 * The browser allows one such request at a time, so call this helper once
 * per page.
 *
 * ```ts
 * // The <script> of the sign-in form. Its username field has
 * // `autocomplete="username webauthn"`.
 * import { useSignInWithUsernamePasskey } from "@convex-dev/auth/methods/username-passkey/svelte";
 * import { api } from "../convex/_generated/api";
 *
 * const login = useSignInWithUsernamePasskey(api.auth);
 *
 * async function onSubmit(username: string) {
 *   const result = await login.signIn({ username });
 *   if (result.status === "error") {
 *     // map result.userError (CEREMONY_ABORTED, …) to a message
 *     console.log(result.userError.error);
 *   }
 * }
 * // In the template, `login.pending` disables the form, and
 * // `login.autofill.lastError` has the last failure of the autofill flow.
 * ```
 *
 * @param usernamePasskeyApi The functions of the method, usually `api.auth`.
 */
export function useSignInWithUsernamePasskey(
  usernamePasskeyApi: UsernamePasskeyApi,
): {
  /**
   * Run the identifier-first passkey flow for the username. Resolves to a
   * result, never rejects: `status` is `"complete"` (with `flow`) or
   * `"error"` (with `userError`).
   */
  signIn: (args: {
    username: string;
  }) => Promise<SignInWithUsernamePasskeyResult>;
  /**
   * `true` while a sign-in runs: a `signIn` call, or an autofill sign-in
   * that the server verifies. A `signIn` call in this time returns
   * `ALREADY_PENDING`.
   */
  readonly pending: boolean;
  /** The state of the autofill flow. */
  autofill: {
    /**
     * Whether the browser can offer passkeys in the autocompletion list;
     * `null` while the detection runs.
     */
    readonly available: boolean | null;
    /** The state of the request; see {@link PasskeyAutofillStatus}. */
    readonly status: PasskeyAutofillStatus;
    /** The most recent failure, for display or logging. */
    readonly lastError: UsernamePasskeyAutofillError | null;
  };
} {
  const { authClient, signInApi, convex } = getConvexAuthContext(
    "useSignInWithUsernamePasskey()",
  );
  const client = createSignInWithUsernamePasskey({
    authClient,
    signInApi,
    convex,
    api: usernamePasskeyApi,
    ceremonies: browserCeremonies,
  });
  // The autofill request runs while the component is mounted.
  onMount(() => client.startAutofill());
  const pending = fromReadableStore(client.pending);
  const autofill = fromReadableStore(client.autofill);
  return {
    signIn: client.signIn,
    get pending() {
      return pending.current;
    },
    autofill: {
      get available() {
        return autofill.current.available;
      },
      get status() {
        return autofill.current.status;
      },
      get lastError() {
        return autofill.current.lastError;
      },
    },
  };
}

/**
 * The "Add a passkey" button of a settings page. Call it during component
 * initialization.
 *
 * The user first authenticates with an existing passkey to prove their
 * identity, then registers the new one.
 *
 * ```ts
 * const adder = useAddPasskey(api.auth);
 *
 * // The onclick of the button, which is disabled while `adder.pending` is true.
 * async function onclick() {
 *   const result = await adder.addPasskey();
 *   if (!result.success) {
 *     console.log(result.userError.error);
 *   }
 * }
 * ```
 *
 * @param managementApi The passkey-management functions, usually `api.auth`.
 */
export function useAddPasskey(managementApi: AddPasskeyApi): {
  /**
   * Add a passkey to the account of the signed-in user. Resolves to
   * `{ success }`, never rejects; on failure, `userError` tells why.
   */
  addPasskey: () => Promise<AddPasskeyResult>;
  /** `true` while an `addPasskey` call runs. */
  readonly pending: boolean;
} {
  const { convex } = getConvexAuthContext("useAddPasskey()");
  const client = createAddPasskey({
    convex,
    api: managementApi,
    ceremonies: browserCeremonies,
  });
  const pending = fromReadableStore(client.pending);
  return {
    addPasskey: client.addPasskey,
    get pending() {
      return pending.current;
    },
  };
}

/**
 * The "Remove" button of a passkey list. Call it during component
 * initialization.
 *
 * The user authenticates with another passkey of the account before the
 * passkey is deleted, so the last passkey can't be removed (`LAST_PASSKEY`).
 *
 * ```ts
 * const remover = useRemovePasskey(api.auth);
 *
 * async function onRemove(passkeyId: string) {
 *   const result = await remover.removePasskey(passkeyId);
 *   if (!result.success) {
 *     console.log(result.userError.error);
 *   }
 * }
 * ```
 *
 * @param managementApi The passkey-management functions, usually `api.auth`.
 */
export function useRemovePasskey(managementApi: RemovePasskeyApi): {
  /**
   * Remove the passkey from the account of the signed-in user. Resolves to
   * `{ success }`, never rejects; on failure, `userError` tells why.
   */
  removePasskey: (passkeyId: string) => Promise<RemovePasskeyResult>;
  /** `true` while a `removePasskey` call runs. */
  readonly pending: boolean;
} {
  const { convex } = getConvexAuthContext("useRemovePasskey()");
  const client = createRemovePasskey({
    convex,
    api: managementApi,
    ceremonies: browserCeremonies,
  });
  const pending = fromReadableStore(client.pending);
  return {
    removePasskey: client.removePasskey,
    get pending() {
      return pending.current;
    },
  };
}
