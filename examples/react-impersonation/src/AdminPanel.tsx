import { useImpersonation } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../convex/_generated/api";

/** Lets an admin act as another user. Renders nothing for everybody else. */
export function AdminPanel() {
  const users = useQuery(api.users.impersonableUsers);
  const { impersonateUser, pending } = useImpersonation(api.auth);
  const [error, setError] = useState<string | null>(null);

  if (!users || users.length === 0) {
    // Loading, not an admin, or nobody to act as
    return null;
  }

  return (
    <section>
      <h2>Act as a user</h2>
      <ul className="user-list">
        {users.map((user) => (
          <li key={user.id}>
            <span>{user.username}</span>
            <button
              disabled={pending}
              onClick={async () => {
                setError(null);
                const result = await impersonateUser(user.id);
                if (result.status === "error") {
                  setError(startErrorMessage(result.userError));
                }
              }}
            >
              Act as {user.username}
            </button>
          </li>
        ))}
      </ul>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function startErrorMessage(
  userError: Extract<
    Awaited<ReturnType<ReturnType<typeof useImpersonation>["impersonateUser"]>>,
    { status: "error" }
  >["userError"],
): string | null {
  switch (userError.error) {
    case "NOT_LOGGED_IN":
      return "Your session has ended. Sign in again.";
    case "NOT_AUTHORIZED":
      return "You are not allowed to act as this user.";
    case "CANNOT_IMPERSONATE_SELF":
      return "You cannot act as yourself.";
    case "ALREADY_IMPERSONATING":
      return "Stop the current impersonation first.";
    case "SESSION_CHANGED":
      // Another tab already switched. This tab follows it.
      return null;
    case "OTHER_ERROR":
      console.error("Starting the impersonation failed:", userError.cause);
      return "Something went wrong. Please try again.";
    default:
      userError satisfies never;
      return "Something went wrong. Please try again.";
  }
}
