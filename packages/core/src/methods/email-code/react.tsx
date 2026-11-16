/**
 * React client for the `emailCode` method, exported at
 * `@convex-dev/auth/methods/email-code/react`.
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
import type { NamespacedStorage } from "../../browser/storage.ts";
import type {
  StartSignInWithEmailCodeResult,
  CompleteSignInWithEmailCodeResult,
} from "./server.ts";

// The secret of the newest code that this browser asked for. It is in the
// storage of the auth client, not in memory, so that the code still works
// after the page reloads, for example when a phone puts an installed web app
// to sleep while the user reads the email.
const SECRET_STORAGE_KEY = "__convexAuthEmailCodeSecret";

/**
 * The mutation threw rather than resolving to a `userError`. The thrown value
 * is preserved on `cause`.
 */
type OtherError = { error: "OTHER_ERROR"; cause: unknown };

/**
 * This browser has not asked for a code, or has already used it: there is no
 * secret in its storage. Ask for a new code.
 */
type MissingSecretError = { error: "MISSING_SECRET" };

type StartMutation = FunctionReference<
  "mutation",
  "public",
  { email: string },
  StartSignInWithEmailCodeResult
>;

type CompleteMutation = FunctionReference<
  "mutation",
  "public",
  { code: string; browserSecret: string },
  ClientView<CompleteSignInWithEmailCodeResult>
>;

/**
 * The functions that {@link useSignInWithEmailCode} calls. The app's
 * `api.auth` has both of them.
 */
export type EmailCodeApi = {
  startSignInWithEmailCode: StartMutation;
  completeSignInWithEmailCode: CompleteMutation;
};

/**
 * The result of the `sendCode` callback from {@link useSignInWithEmailCode}.
 * The hook keeps the secret, thus the success arm has none.
 */
export type SendCodeResult =
  | { success: true }
  | Extract<StartSignInWithEmailCodeResult, { success: false }>
  | { success: false; userError: OtherError };

/** The result of the `signIn` callback from {@link useSignInWithEmailCode}. */
export type SignInResult =
  | ClientView<CompleteSignInWithEmailCodeResult>
  | { status: "error"; userError: MissingSecretError | OtherError };

function useSecretStorage(): NamespacedStorage {
  const authClient = useContext(AuthClientContext);
  if (authClient === undefined) {
    throw new Error("Must be used within a <ConvexAuthProvider>.");
  }
  return authClient.storage;
}

/** Track the in-flight state of async calls. */
function usePending() {
  const [pending, setPending] = useState(false);
  // Count the calls in flight, in case the app starts a second one before
  // the first ends.
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
 * Client for the sign-in flow: `sendCode` emails a code and keeps the secret
 * of this browser, and `signIn` checks the typed code and establishes the
 * session. The same flow signs up a new user.
 *
 * Only the newest code works in this browser: a new `sendCode` replaces the
 * secret of the previous one.
 *
 * ```tsx
 * function SignIn() {
 *   const { sendCode, signIn, pending } = useSignInWithEmailCode(api.auth);
 *   const [email, setEmail] = useState("");
 *   const [code, setCode] = useState("");
 *   const [sent, setSent] = useState(false);
 *   const [error, setError] = useState<string | null>(null);
 *
 *   if (!sent) {
 *     return (
 *       <form
 *         onSubmit={async (e) => {
 *           e.preventDefault();
 *           const result = await sendCode({ email });
 *           // map result.userError (INVALID_EMAIL, RATE_LIMITED, …) to a message
 *           setError(result.success ? null : result.userError.error);
 *           setSent(result.success);
 *         }}
 *       >
 *         <input
 *           type="email"
 *           autoComplete="email"
 *           required
 *           value={email}
 *           onChange={(e) => setEmail(e.target.value)}
 *           disabled={pending}
 *         />
 *         {error !== null && <p role="alert">{error}</p>}
 *         <button type="submit" disabled={pending}>
 *           Send code
 *         </button>
 *       </form>
 *     );
 *   }
 *
 *   return (
 *     <form
 *       onSubmit={async (e) => {
 *         e.preventDefault();
 *         const result = await signIn({ code });
 *         // map result.userError (INCORRECT_CODE, TOO_MANY_ATTEMPTS, …) to a message
 *         setError(result.status === "error" ? result.userError.error : null);
 *       }}
 *     >
 *       <input
 *         inputMode="numeric"
 *         autoComplete="one-time-code"
 *         required
 *         value={code}
 *         onChange={(e) => setCode(e.target.value)}
 *         disabled={pending}
 *       />
 *       {error !== null && <p role="alert">{error}</p>}
 *       <button type="submit" disabled={pending}>
 *         Sign in
 *       </button>
 *     </form>
 *   );
 * }
 * ```
 *
 * @param api The functions of the method, usually `api.auth`.
 */
export function useSignInWithEmailCode(api: EmailCodeApi) {
  // Sending a code mints no session, so it calls Convex directly rather than
  // going through the `AuthSignInApi`. Under SSR, that API is the auth proxy,
  // which only serves functions returning the sign-in envelope.
  const runStart = useMutation(api.startSignInWithEmailCode);
  const completeMutation = useStableFunctionReference(
    api.completeSignInWithEmailCode,
  );
  const signInApi = useAuthSignInApi();
  const { setSession } = useAuthActions();
  const storage = useSecretStorage();
  const { pending, track } = usePending();

  const sendCode = useCallback(
    async (args: { email: string }): Promise<SendCodeResult> =>
      track(async () => {
        try {
          const result = await runStart(args);
          if (!result.success) {
            return result;
          }
          await storage.set(SECRET_STORAGE_KEY, result.browserSecret);
          return { success: true };
        } catch (cause) {
          return { success: false, userError: { error: "OTHER_ERROR", cause } };
        }
      }),
    [runStart, storage, track],
  );

  const signIn = useCallback(
    async (args: { code: string }): Promise<SignInResult> =>
      track(async () => {
        try {
          const browserSecret = await storage.get(SECRET_STORAGE_KEY);
          if (browserSecret === null || browserSecret === undefined) {
            return {
              status: "error",
              userError: { error: "MISSING_SECRET" },
            };
          }
          const result = await signInApi.mutation(completeMutation, {
            code: args.code,
            browserSecret,
          });
          if (result.status === "complete") {
            await storage.remove(SECRET_STORAGE_KEY);
            await setSession(result.tokens);
          }
          return result;
        } catch (cause) {
          return {
            status: "error",
            userError: { error: "OTHER_ERROR", cause },
          };
        }
      }),
    [storage, signInApi, completeMutation, setSession, track],
  );

  return { sendCode, signIn, pending };
}
