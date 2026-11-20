import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { AdminPanel } from "../AdminPanel";
import { PasswordSettings } from "../PasswordSettings";

export function Dashboard() {
  const user = useQuery(api.currentUser.loggedInUser);
  const impersonation = useQuery(api.auth.impersonation);
  const { signOut } = useAuthActions();
  return (
    <>
      {user && (
        <>
          <p>
            Signed in as <strong>{user.username}</strong> ({user.role})
          </p>
          {/* The backend refuses a password change during an impersonation,
              so don't offer one. */}
          {impersonation === null && <PasswordSettings />}
          <AdminPanel />
        </>
      )}
      <button onClick={() => signOut()}>Sign out</button>
    </>
  );
}
