import type { ChangePasswordResult } from "@convex-dev/auth/methods/username-password/server";
import { DEFAULT_MIN_PASSWORD_LENGTH } from "@convex-dev/auth/methods/username-password";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../convex/_generated/api";

export function PasswordSettings() {
  const user = useQuery(api.currentUser.loggedInUser);
  const changePassword = useMutation(api.auth.changePassword);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [signOutOtherSessions, setSignOutOtherSessions] = useState(true);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  if (!user) {
    // Loading, or not signed in
    return null;
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setStatus(null);
        setPending(true);
        try {
          const result = await changePassword({
            currentPassword,
            newPassword,
            signOutOtherSessions,
          });
          if (result.success) {
            setCurrentPassword("");
            setNewPassword("");
            setStatus("Your password has been changed.");
          } else {
            setStatus(errorMessage(result.userError));
          }
        } catch (cause) {
          console.error("Password change failed:", cause);
          setStatus("Something went wrong. Please try again.");
        } finally {
          setPending(false);
        }
      }}
    >
      <h2>Change your password</h2>
      {/* Hidden username, so that password managers know which login to update */}
      <input
        // Using a static id to help password managers behave correctly
        id="username"
        name="username"
        type="text"
        value={user.username}
        autoComplete="username"
        readOnly
        style={{ display: "none" }}
      />
      <label htmlFor="current-password">
        Current password
        <input
          // Using a static id to help password managers behave correctly
          id="current-password"
          name="current-password"
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          autoComplete="current-password"
          required
          disabled={pending}
        />
      </label>
      <label htmlFor="new-password">
        New password
        <input
          // Using a static id to help password managers behave correctly
          id="new-password"
          name="new-password"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
          minLength={DEFAULT_MIN_PASSWORD_LENGTH}
          required
          disabled={pending}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={signOutOtherSessions}
          onChange={(e) => setSignOutOtherSessions(e.target.checked)}
          disabled={pending}
        />
        Sign out of all other devices
      </label>
      {status && (
        <p role="alert">
          <strong>{status}</strong>
        </p>
      )}
      <button type="submit" disabled={pending}>
        {pending ? "Changing password…" : "Change password"}
      </button>
    </form>
  );
}

function errorMessage(
  userError: Extract<ChangePasswordResult, { success: false }>["userError"],
): string {
  switch (userError.error) {
    case "INVALID_CREDENTIALS":
      return "Incorrect current password.";
    case "RATE_LIMITED":
      return `Too many attempts. Try again in ${Math.ceil(userError.retryAfterMs / 1000)} seconds.`;
    case "PASSWORD_TOO_SHORT":
      return `Your new password must be at least ${userError.minimumLength} characters.`;
    case "PASSWORD_TOO_LONG":
      return `Your new password must be at most ${userError.maximumLength} characters.`;
    case "PASSWORD_HAS_SURROUNDING_WHITESPACE":
      return "Your new password can't start or end with whitespace.";
    case "PASSWORD_TOO_COMMON":
      return "Your new password is one of the most commonly used passwords. Please choose a different one.";
    case "NOT_SIGNED_IN":
      return "Your session has ended. Please log in again.";
    default:
      userError satisfies never;
      return `Unknown error: ${JSON.stringify(userError)}`;
  }
}
