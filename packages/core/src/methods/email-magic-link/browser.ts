/**
 * Framework-agnostic client for the `emailMagicLink` method, exported at
 * `@convex-dev/auth/methods/email-magic-link/browser`. The React hooks of
 * `@convex-dev/auth/methods/email-magic-link/react` wrap it, and a binding
 * for another framework can too.
 *
 * Sending the link keeps a secret in `authClient.methodStorage` of the
 * browser, and the link only works in that browser. The client of the
 * landing page has a `start` function: call it when the page mounts, and
 * call the function it returns when the page unmounts.
 *
 * ```ts
 * import type { AuthClient, AuthSignInApi } from "@convex-dev/auth/browser";
 * import { createSignInWithEmailMagicLink } from "@convex-dev/auth/methods/email-magic-link/browser";
 * import { api } from "../convex/_generated/api";
 *
 * declare const authClient: AuthClient;
 * declare const signInApi: AuthSignInApi;
 *
 * // The landing page of the link.
 * const flow = createSignInWithEmailMagicLink({
 *   authClient,
 *   signInApi,
 *   api: api.auth,
 *   emailCode: new URL(window.location.href).searchParams.get("code") ?? "",
 * });
 * flow.state.subscribe(() => {
 *   const state = flow.state.get();
 *   // render state.status: "loading", "complete", or "error"
 * });
 * // On mount. The returned function is the cleanup, for the unmount.
 * const stop = flow.start();
 * ```
 *
 * @module
 */

import type { FunctionReference } from "convex/server";
import type {
  AuthSignInApi,
  ConvexMutationApi,
} from "../../browser/ambientSignInClient.ts";
import {
  createLinkFlow,
  createStartFlow,
  type LinkFlowClient,
  type LinkFlowState,
  type MissingSecretError,
  type OtherError,
  type UnexpectedFailure,
  type WithoutSecret,
} from "../../browser/linkFlow.ts";
import type { AuthClient } from "../../browser/sessionManager.ts";
import type { ReadableStore } from "../../browser/store.ts";
import type { ClientView } from "../../lib/types.ts";
import type {
  SendResult as SendMutationResult,
  SignInResult as SignInMutationResult,
} from "./server.ts";

export type { ReadableStore } from "../../browser/store.ts";
export type { LinkFlowClient, LinkFlowState } from "../../browser/linkFlow.ts";

// Two sign-ins in one browser share this key: the second one replaces the
// secret of the first, thus only the newest link works.
const SECRET_STORAGE_KEY = "__convexAuthEmailMagicLinkSecret";

/** The app's `sendEmailMagicLink` mutation. */
export type SendEmailMagicLinkMutation = FunctionReference<
  "mutation",
  "public",
  { email: string },
  SendMutationResult
>;

/** The app's `signInWithEmailMagicLink` mutation. */
export type SignInWithEmailMagicLinkMutation = FunctionReference<
  "mutation",
  "public",
  { emailCode: string; browserSecret: string },
  ClientView<SignInMutationResult>
>;

/** The result of `sendMagicLink` from {@link createSendEmailMagicLink}. */
export type SendResult = WithoutSecret<SendMutationResult> | UnexpectedFailure;

/** The `userError` of a failed `signInWithEmailMagicLink`. */
type SignInUserError = Extract<
  ClientView<SignInMutationResult>,
  { status: "error" }
>["userError"];

/** The state of {@link createSignInWithEmailMagicLink}. */
export type SignInState = LinkFlowState<
  SignInUserError | MissingSecretError | OtherError
>;

/** The client of the form that sends the link. */
export type SendEmailMagicLinkClient = {
  /**
   * Send a sign-in link to the address, and keep the returned secret for
   * {@link createSignInWithEmailMagicLink}. Resolves to a result, never
   * rejects.
   */
  sendMagicLink: (args: { email: string }) => Promise<SendResult>;
  /** `true` while a link is being sent. */
  pending: ReadableStore<boolean>;
};

/**
 * Make the client of the one form of the method: send a sign-in link to the
 * address, and keep the returned secret for
 * {@link createSignInWithEmailMagicLink}. The same call serves a person who
 * has an account and a person who has none.
 */
export function createSendEmailMagicLink(options: {
  /** The client whose `methodStorage` keeps the secret. */
  authClient: Pick<AuthClient, "methodStorage">;
  /**
   * Runs the mutation on the Convex client of the app. Sending the link mints
   * no session, so it does not go through the `AuthSignInApi`.
   */
  convex: ConvexMutationApi;
  /** The functions of the method, usually `api.auth`. */
  api: { sendEmailMagicLink: SendEmailMagicLinkMutation };
}): SendEmailMagicLinkClient {
  const { run, pending } = createStartFlow(
    options,
    () => options.api.sendEmailMagicLink,
    SECRET_STORAGE_KEY,
  );
  return { sendMagicLink: run, pending };
}

/**
 * Make the client of the landing page of the link: once started, it presents
 * the code from the link with the secret stored by
 * {@link createSendEmailMagicLink}, and adopts the minted session.
 *
 * While the server checks the link and the client stores the new session,
 * the `AuthClient` reports `isLoading`. A failed sign-in keeps the secret:
 * the person may have opened an older link, and the newest one must still
 * work.
 */
export function createSignInWithEmailMagicLink(options: {
  /** The client the session goes to, and whose storage has the secret. */
  authClient: Pick<
    AuthClient,
    | "setSession"
    | "withSignInPending"
    | "methodStorage"
    | "getSnapshot"
    | "subscribe"
  >;
  /** Runs the mutation, which mints a session. */
  signInApi: AuthSignInApi;
  /** The functions of the method, usually `api.auth`. */
  api: { signInWithEmailMagicLink: SignInWithEmailMagicLinkMutation };
  /** The `code` query parameter of the link. */
  emailCode: string;
}): LinkFlowClient<SignInState> {
  return createLinkFlow<SignInUserError>(
    options,
    SECRET_STORAGE_KEY,
    (browserSecret) =>
      options.authClient.withSignInPending(async () => {
        const result = await options.signInApi.mutation(
          options.api.signInWithEmailMagicLink,
          { emailCode: options.emailCode, browserSecret },
        );
        if (result.status === "complete") {
          await options.authClient.setSession(result.tokens);
          return { done: true } as const;
        }
        return { done: false, userError: result.userError } as const;
      }),
  );
}
