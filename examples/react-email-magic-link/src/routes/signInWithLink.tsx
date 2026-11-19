import { useSignInWithEmailMagicLink } from "@convex-dev/auth/methods/email-magic-link/react";
import type { ReactNode } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { api } from "../../convex/_generated/api";

/**
 * Landing page for the sign-in link (`/sign-in-with-link?code=…`). The hook
 * presents the link as soon as the page opens, which signs the user in.
 */
export function SignInWithLink() {
  const [params] = useSearchParams();
  const emailCode = params.get("code");
  if (emailCode === null) {
    return <p>This link is incomplete. Use the link from your email.</p>;
  }
  return <SignInWithCode emailCode={emailCode} />;
}

function SignInWithCode({ emailCode }: { emailCode: string }) {
  const state = useSignInWithEmailMagicLink(api.auth, { emailCode });

  if (state.status === "loading") {
    return <p>Signing you in…</p>;
  }
  if (state.status === "complete") {
    return <Navigate to="/" replace />;
  }
  switch (state.userError.error) {
    case "MISSING_SECRET":
      return (
        // This browser has no pending sign-in: the link was requested from
        // another browser, or this browser already used it.
        <SignInError>
          This link does not work here. For your security, a sign-in link only
          works once, in the browser where you asked for it.
        </SignInError>
      );
    case "INVALID_CHALLENGE":
      return (
        <SignInError>
          This link is no longer valid. It may have expired or already been
          used.
        </SignInError>
      );
    case "INCORRECT_CODE":
      return (
        <SignInError>
          This is not the latest link. Open the newest email we sent you.
        </SignInError>
      );
    case "OTHER_ERROR":
      console.error("Sign-in failed:", state.userError.cause);
      return (
        <SignInError>
          Something went wrong. Reload the page to try again.
        </SignInError>
      );
    default:
      state.userError satisfies never;
      return (
        <SignInError>
          Something went wrong. Reload the page to try again.
        </SignInError>
      );
  }
}

function SignInError({
  title = "Could not sign you in",
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <>
      <h1>{title}</h1>
      <p role="alert">
        <strong>{children}</strong>
      </p>
      <p>
        <a href="/sign-in">Ask for a new link</a>.
      </p>
    </>
  );
}
