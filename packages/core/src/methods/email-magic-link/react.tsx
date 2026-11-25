/**
 * React client for the `emailMagicLink` method, exported at
 * `@convex-dev/auth/methods/email-magic-link/react`. The hooks wrap the
 * framework-agnostic clients of
 * `@convex-dev/auth/methods/email-magic-link/browser`.
 *
 * @module
 */
"use client";

import { useEffect } from "react";
import {
  useAuthClient,
  useAuthSignInApi,
  useConvexMutations,
} from "../../react/client.tsx";
import { useAuthActions } from "../../react/index.tsx";
import { useMethodClient, useReadableStore } from "../../react/store.ts";
import {
  createSendEmailMagicLink,
  createSignInWithEmailMagicLink,
  type SendEmailMagicLinkMutation,
  type SignInState,
  type SignInWithEmailMagicLinkMutation,
} from "./browser.ts";

export type { SendResult, SignInState } from "./browser.ts";

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
  sendEmailMagicLink: SendEmailMagicLinkMutation;
}) {
  // Sending the link mints no session, so it calls Convex directly rather
  // than going through the `AuthSignInApi`.
  const convex = useConvexMutations();
  const authClient = useAuthClient();
  const client = useMethodClient(createSendEmailMagicLink, {
    authClient,
    convex,
    api,
  });
  const pending = useReadableStore(client.pending);
  return { sendMagicLink: client.sendMagicLink, pending };
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
  api: { signInWithEmailMagicLink: SignInWithEmailMagicLinkMutation },
  { emailCode }: { emailCode: string },
): SignInState {
  // Outside a provider, throw the error the other hooks throw.
  useAuthActions();
  const authClient = useAuthClient();
  const signInApi = useAuthSignInApi();
  const client = useMethodClient(createSignInWithEmailMagicLink, {
    authClient,
    signInApi,
    api,
    emailCode,
  });
  // Presents the link once, on page load. In StrictMode the cleanup of the
  // first run only cancels a start that still waits for the auth client.
  useEffect(() => client.start(), [client]);
  return useReadableStore(client.state);
}
