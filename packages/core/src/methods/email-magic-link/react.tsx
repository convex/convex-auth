/**
 * React client for the `emailMagicLink` method, exported at
 * `@convex-dev/auth/methods/email-magic-link/react`.
 *
 * @module
 */
"use client";

import { FunctionReference } from "convex/server";
import { useMutation } from "convex/react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ClientView } from "../../lib/types.ts";
import {
  AuthClientContext,
  useAuth,
  useAuthSignInApi,
} from "../../react/client.tsx";
import { useAuthActions } from "../../react/index.tsx";
import { useStableFunctionReference } from "../../react/functionReference.ts";
import type {
  SendResult as SendMutationResult,
  SignInResult as SignInMutationResult,
} from "./server.ts";

// Two sign-ins in one browser share this key: the second one replaces the
// secret of the first, thus only the newest link works.
const SECRET_STORAGE_KEY = "__convexAuthEmailMagicLinkSecret";

/** The mutation threw rather than resolving to a `userError`. */
type OtherError = { error: "OTHER_ERROR"; cause: unknown };

/**
 * The link was opened in a browser that did not start the sign-in: the
 * secret is not in this browser's storage.
 */
type MissingSecretError = { error: "MISSING_SECRET" };

type SendMutation = FunctionReference<
  "mutation",
  "public",
  { email: string },
  SendMutationResult
>;

type SignInMutation = FunctionReference<
  "mutation",
  "public",
  { emailCode: string; browserSecret: string },
  ClientView<SignInMutationResult>
>;

/** The result of the `sendMagicLink` callback from {@link useSendEmailMagicLink}. */
export type SendResult =
  | { success: true }
  | Extract<SendMutationResult, { success: false }>
  | { success: false; userError: OtherError };

/** The state of {@link useSignInWithEmailMagicLink}. */
export type SignInState =
  | { status: "loading" }
  | { status: "complete" }
  | {
      status: "error";
      userError:
        | Extract<
            ClientView<SignInMutationResult>,
            { status: "error" }
          >["userError"]
        | MissingSecretError
        | OtherError;
    };

function useAuthClient() {
  const authClient = useContext(AuthClientContext);
  if (authClient === undefined) {
    throw new Error("Must be used within a <ConvexAuthProvider>.");
  }
  return authClient;
}

/**
 * Client for the one form of the method: send a sign-in link to the address,
 * and keep the returned secret for {@link useSignInWithEmailMagicLink}. The
 * same call serves a person who has an account and a person who has none.
 *
 * ```tsx
 * function SignIn() {
 *   const { sendMagicLink, pending } = useSendEmailMagicLink(api.auth);
 *   const [email, setEmail] = useState("");
 *   const [sent, setSent] = useState(false);
 *   const [error, setError] = useState<string | null>(null);
 *   if (sent) {
 *     return <p>We sent a sign-in link to {email}.</p>;
 *   }
 *   return (
 *     <form
 *       onSubmit={async (e) => {
 *         e.preventDefault();
 *         setError(null);
 *         const result = await sendMagicLink({ email });
 *         if (result.success) {
 *           setSent(true);
 *         } else {
 *           setError(result.userError.error);
 *         }
 *       }}
 *     >
 *       <input
 *         type="email"
 *         value={email}
 *         onChange={(e) => setEmail(e.target.value)}
 *       />
 *       <button type="submit" disabled={pending}>
 *         Continue with email
 *       </button>
 *       {error !== null && <p>Could not send the link: {error}</p>}
 *     </form>
 *   );
 * }
 * ```
 *
 * @param api The functions of the method, usually `api.auth`.
 */
export function useSendEmailMagicLink(api: {
  sendEmailMagicLink: SendMutation;
}) {
  // Sending the link mints no session, so it calls Convex directly rather
  // than going through the `AuthSignInApi`.
  const runSend = useMutation(api.sendEmailMagicLink);
  const { storage } = useAuthClient();
  const [pending, setPending] = useState(false);
  // Count the calls in flight, so that `pending` stays true until the last
  // one ends if the app starts a second call before the first one ends.
  const inFlight = useRef(0);

  const sendMagicLink = useCallback(
    async (args: { email: string }): Promise<SendResult> => {
      inFlight.current++;
      setPending(true);
      try {
        const result = await runSend(args);
        if (result.success) {
          await storage.set(SECRET_STORAGE_KEY, result.browserSecret);
          return { success: true };
        }
        return result;
      } catch (cause) {
        return { success: false, userError: { error: "OTHER_ERROR", cause } };
      } finally {
        if (--inFlight.current === 0) setPending(false);
      }
    },
    [runSend, storage],
  );

  return { sendMagicLink, pending };
}

/**
 * Client for the landing page of the link: as soon as the page opens,
 * present the code from the link with the secret stored by
 * {@link useSendEmailMagicLink}, and adopt the minted session.
 *
 * ```tsx
 * function SignInWithLink({ emailCode }: { emailCode: string }) {
 *   const state = useSignInWithEmailMagicLink(api.auth, { emailCode });
 *   switch (state.status) {
 *     case "loading": // signing in…
 *     case "complete": // signed in
 *     case "error": // map state.userError to a message
 *   }
 * }
 * ```
 *
 * @param api The functions of the method, usually `api.auth`.
 * @param emailCode The `code` query parameter of the link.
 */
export function useSignInWithEmailMagicLink(
  api: { signInWithEmailMagicLink: SignInMutation },
  { emailCode }: { emailCode: string },
): SignInState {
  const signInMutation = useStableFunctionReference(
    api.signInWithEmailMagicLink,
  );
  const { setSession } = useAuthActions();
  const signInApi = useAuthSignInApi();
  const { storage, withSignInPending } = useAuthClient();
  const { isLoading } = useAuth();
  const [state, setState] = useState<SignInState>({ status: "loading" });

  // Present the link once, also in React strict mode.
  const started = useRef(false);

  useEffect(() => {
    if (isLoading || started.current) {
      return;
    }
    started.current = true;
    void (async () => {
      try {
        const browserSecret = await storage.get(SECRET_STORAGE_KEY);
        if (browserSecret === null || browserSecret === undefined) {
          setState({ status: "error", userError: { error: "MISSING_SECRET" } });
          return;
        }
        // Keep `isLoading` true while the server checks the link and the
        // client stores the new session.
        const result = await withSignInPending(async () => {
          const result = await signInApi.mutation(signInMutation, {
            emailCode,
            browserSecret,
          });
          if (result.status === "complete") {
            await setSession(result.tokens);
          }
          return result;
        });
        if (result.status === "complete") {
          await storage.remove(SECRET_STORAGE_KEY);
          setState({ status: "complete" });
        } else {
          // A failed sign-in keeps the secret: the person may have opened an
          // older link, and the newest one must still work.
          setState({ status: "error", userError: result.userError });
        }
      } catch (cause) {
        setState({
          status: "error",
          userError: { error: "OTHER_ERROR", cause },
        });
      }
    })();
  }, [
    isLoading,
    storage,
    signInApi,
    signInMutation,
    emailCode,
    setSession,
    withSignInPending,
  ]);

  return state;
}
