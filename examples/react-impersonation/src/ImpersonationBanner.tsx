import { useImpersonation } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../convex/_generated/api";

/**
 * Shown on every page while the session is an impersonation, so that the
 * person at the keyboard always knows they act as somebody else.
 */
export function ImpersonationBanner() {
  const impersonation = useQuery(api.auth.impersonation);
  const user = useQuery(api.currentUser.loggedInUser);
  const { stopImpersonating, pending } = useImpersonation(api.auth);
  const [error, setError] = useState<string | null>(null);

  if (!impersonation || !user) {
    // Loading, or not an impersonation
    return null;
  }

  return (
    <div className="impersonation-banner" role="status">
      <p>
        You are acting as <strong>{user.username}</strong> until{" "}
        {new Date(impersonation.expiresAt).toLocaleTimeString()}.
      </p>
      <button
        disabled={pending}
        onClick={async () => {
          setError(null);
          const result = await stopImpersonating();
          if (result.status === "error") {
            setError(stopErrorMessage(result.userError));
          }
        }}
      >
        Stop impersonating
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

function stopErrorMessage(
  userError: Extract<
    Awaited<
      ReturnType<ReturnType<typeof useImpersonation>["stopImpersonating"]>
    >,
    { status: "error" }
  >["userError"],
): string | null {
  switch (userError.error) {
    case "NOT_IMPERSONATING":
    case "SESSION_CHANGED":
      // Another tab already stopped. This tab follows it.
      return null;
    case "IMPERSONATOR_SESSION_ENDED":
      // The client signs out immediately and returns to the sign-in screen.
      return null;
    case "OTHER_ERROR":
      console.error("Stopping the impersonation failed:", userError.cause);
      return "Something went wrong. Please try again.";
    default:
      userError satisfies never;
      return "Something went wrong. Please try again.";
  }
}
