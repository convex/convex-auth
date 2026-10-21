import { type ReactNode, useState } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import {
  useOauth,
  useSignInWithGithub,
} from "@convex-dev/auth/methods/github/react";
import { api } from "../convex/_generated/api";

/**
 * A failure to start comes back from the sign-in call, and a failure after the
 * redirect back shows up in `useOauth`'s `flowError`. Each is handled with an
 * exhaustive switch on its code.
 */
function SignedOut(): ReactNode {
  const { signIn } = useSignInWithGithub(api.auth);
  const { flowError } = useOauth();
  const [startError, setStartError] = useState<string | null>(null);
  return (
    <>
      <h1>Sign in</h1>
      <p>Continue with your GitHub account</p>
      {flowError !== null && (
        <p role="alert">
          <strong>
            {(() => {
              switch (flowError.error) {
                case "ACCESS_DENIED":
                  return "Sign-in was cancelled.";
                case "EXPIRED":
                  return "That sign-in took too long. Please try again.";
                case "INVALID_FLOW":
                  return "This sign-in can't be completed here. Please try again.";
                case "REJECTED":
                  // Your backend rejected the sign-in with a ConvexError,
                  // and `data` is its data. Show it when it's text for the
                  // user.
                  return typeof flowError.data === "string"
                    ? flowError.data
                    : "Sign-in was declined.";
                case "OTHER_ERROR":
                  // The details are on `cause` if you want to log them.
                  return "Something went wrong during sign-in. Please try again.";
                default:
                  flowError satisfies never;
                  return `Unknown error: ${JSON.stringify(flowError)}`;
              }
            })()}
          </strong>
        </p>
      )}
      {startError !== null && (
        <p role="alert">
          <strong>{startError}</strong>
        </p>
      )}
      <button
        type="button"
        onClick={async () => {
          setStartError(null);
          const result = await signIn();
          if (result.status === "redirect") return;
          switch (result.userError.error) {
            case "OTHER_ERROR":
              // The flow couldn't start, e.g. the deployment was
              // unreachable. The original error is on `cause` if you want
              // to log or inspect it.
              console.error(
                "GitHub sign-in failed to start:",
                result.userError.cause,
              );
              setStartError("Couldn't start GitHub sign-in. Please try again.");
              return;
            default:
              result.userError.error satisfies never;
              console.error(
                "GitHub sign-in failed to start:",
                result.userError,
              );
              setStartError("Couldn't start GitHub sign-in. Please try again.");
          }
        }}
      >
        Continue with GitHub
      </button>
    </>
  );
}

function SignedIn(): ReactNode {
  const { signOut } = useAuthActions();
  const user = useQuery(api.users.getCurrentUser);
  return (
    <>
      <h1>Signed in</h1>
      <p>{user?.id ?? "…"}</p>
      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </>
  );
}

export default function App(): ReactNode {
  const { isLoading, isAuthenticated } = useConvexAuth();
  return (
    <main>
      {isLoading && <p>Signing you in…</p>}
      {!isLoading && isAuthenticated && <SignedIn />}
      {!isLoading && !isAuthenticated && <SignedOut />}
    </main>
  );
}
