/**
 * React client for the `emailShortCode` method, exported at
 * `@convex-dev/auth/methods/email-short-code/react`.
 *
 * @module
 */
"use client";

import { FunctionReference } from "convex/server";
import { useMutation } from "convex/react";
import { useCallback, useContext, useRef, useState } from "react";
import type { ClientView } from "../../lib/types.ts";
import { AuthClientContext, useAuthSignInApi } from "../../react/client.tsx";
import { useAuthActions } from "../../react/index.tsx";
import { useStableFunctionReference } from "../../react/functionReference.ts";
import type {
  SendResult as SendMutationResult,
  SignInResult as SignInMutationResult,
} from "./server.ts";

// Two sign-ins in one browser share this key: the second one replaces the
// secret of the first, thus only the code of the newest email works.
const SECRET_STORAGE_KEY = "__convexAuthEmailShortCodeSecret";

/** The mutation threw rather than resolving to a `userError`. */
type OtherError = { error: "OTHER_ERROR"; cause: unknown };

/**
 * No sign-in is in progress in this browser: the secret is not in its
 * storage. The user must ask for a code first, in this browser.
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

/** The result of the `sendCode` callback from {@link useSendEmailShortCode}. */
export type SendResult =
  | { success: true }
  | Extract<SendMutationResult, { success: false }>
  | { success: false; userError: OtherError };

/** The result of the `signIn` callback from {@link useSignInWithEmailShortCode}. */
export type SignInResult =
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
 * Track the in-flight state of async calls. `pending` stays true until the
 * last call ends if the app starts a second call before the first one ends.
 */
function usePending() {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(0);
  const track = useCallback(async <T,>(work: () => Promise<T>): Promise<T> => {
    inFlight.current++;
    setPending(true);
    try {
      return await work();
    } finally {
      if (--inFlight.current === 0) setPending(false);
    }
  }, []);
  return { pending, track };
}

/**
 * Client for the first step of the method: send a sign-in code to the
 * address, and keep the returned secret for
 * {@link useSignInWithEmailShortCode}. The same call serves a person who has
 * an account and a person who has none.
 *
 * Call it again to send a new code: the new secret replaces the old one,
 * thus only the code of the newest email works.
 *
 * ```tsx
 * function EmailStep({ onSent }: { onSent: (email: string) => void }) {
 *   const { sendCode, pending } = useSendEmailShortCode(api.auth);
 *   const [email, setEmail] = useState("");
 *   const [error, setError] = useState<string | null>(null);
 *   return (
 *     <form
 *       onSubmit={async (e) => {
 *         e.preventDefault();
 *         setError(null);
 *         const result = await sendCode({ email });
 *         if (result.success) {
 *           onSent(email);
 *         } else {
 *           setError(result.userError.error);
 *         }
 *       }}
 *     >
 *       <input
 *         type="email"
 *         autoComplete="email"
 *         value={email}
 *         onChange={(e) => setEmail(e.target.value)}
 *       />
 *       <button type="submit" disabled={pending}>
 *         Continue with email
 *       </button>
 *       {error !== null && <p>Could not send the code: {error}</p>}
 *     </form>
 *   );
 * }
 * ```
 *
 * @param api The functions of the method, usually `api.auth`.
 */
export function useSendEmailShortCode(api: {
  sendEmailShortCode: SendMutation;
}) {
  // Sending the code mints no session, so it calls Convex directly rather
  // than going through the `AuthSignInApi`.
  const runSend = useMutation(api.sendEmailShortCode);
  const { storage } = useAuthClient();
  const { pending, track } = usePending();

  const sendCode = useCallback(
    (args: { email: string }): Promise<SendResult> =>
      track(async () => {
        try {
          const result = await runSend(args);
          if (result.success) {
            await storage.set(SECRET_STORAGE_KEY, result.browserSecret);
            return { success: true };
          }
          return result;
        } catch (cause) {
          return {
            success: false,
            userError: { error: "OTHER_ERROR", cause },
          };
        }
      }),
    [runSend, storage, track],
  );

  return { sendCode, pending };
}

/**
 * Client for the second step of the method: present the code that the user
 * typed with the secret stored by {@link useSendEmailShortCode}, and adopt
 * the minted session.
 *
 * The code can contain spaces and dashes (for example "0471 8295"): the
 * server removes them.
 *
 * ```tsx
 * function CodeStep({ email }: { email: string }) {
 *   const { signIn, pending } = useSignInWithEmailShortCode(api.auth);
 *   const [code, setCode] = useState("");
 *   const [error, setError] = useState<string | null>(null);
 *   return (
 *     <form
 *       onSubmit={async (e) => {
 *         e.preventDefault();
 *         setError(null);
 *         const result = await signIn({ code });
 *         if (result.status === "error") {
 *           setError(result.userError.error);
 *         }
 *       }}
 *     >
 *       <p>We sent a code to {email}.</p>
 *       <input
 *         autoComplete="one-time-code"
 *         inputMode="numeric"
 *         value={code}
 *         onChange={(e) => setCode(e.target.value)}
 *       />
 *       <button type="submit" disabled={pending}>
 *         Sign in
 *       </button>
 *       {error !== null && <p>Could not sign in: {error}</p>}
 *     </form>
 *   );
 * }
 * ```
 *
 * @param api The functions of the method, usually `api.auth`.
 */
export function useSignInWithEmailShortCode(api: {
  signInWithEmailShortCode: SignInMutation;
}) {
  const signInMutation = useStableFunctionReference(
    api.signInWithEmailShortCode,
  );
  const { setSession } = useAuthActions();
  const signInApi = useAuthSignInApi();
  const { storage } = useAuthClient();
  const { pending, track } = usePending();

  const signIn = useCallback(
    ({ code }: { code: string }): Promise<SignInResult> =>
      track(async () => {
        try {
          const browserSecret = await storage.get(SECRET_STORAGE_KEY);
          if (browserSecret === null || browserSecret === undefined) {
            return {
              status: "error",
              userError: { error: "MISSING_SECRET" },
            };
          }
          const result = await signInApi.mutation(signInMutation, {
            emailCode: code,
            browserSecret,
          });
          if (result.status !== "complete") {
            // A failed sign-in keeps the secret: the user can correct a
            // typo, or try again after a rate limit.
            return { status: "error", userError: result.userError };
          }
          await setSession(result.tokens);
          await storage.remove(SECRET_STORAGE_KEY);
          return { status: "complete" };
        } catch (cause) {
          return {
            status: "error",
            userError: { error: "OTHER_ERROR", cause },
          };
        }
      }),
    [signInApi, signInMutation, setSession, storage, track],
  );

  return { signIn, pending };
}
