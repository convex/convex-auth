import { useMutation } from "convex/react";
import { useState } from "react";
import { api } from "../convex/_generated/api";

export function ChangePasswordForm({
  currentEmail,
}: {
  currentEmail: string | undefined;
}) {
  const changePassword = useMutation(api.auth.changePassword);
  const [pending, setPending] = useState(false);
  const [currentPasswordField, setCurrentPasswordField] = useState("");
  const [newPasswordField, setNewPasswordField] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setMessage(null);
        setPending(true);
        try {
          const result = await changePassword({
            currentPassword: currentPasswordField,
            newPassword: newPasswordField,
          });
          if (result.success) {
            setCurrentPasswordField("");
            setNewPasswordField("");
            setMessage("Your password was changed.");
            return;
          }
          setMessage(() => {
            switch (result.userError.error) {
              case "NOT_LOGGED_IN":
                return "You are not logged in.";
              case "INVALID_CREDENTIALS":
                return "The current password is incorrect.";
              case "PASSWORD_TOO_SHORT":
                return `Password must be at least ${result.userError.minimumLength} characters.`;
              case "PASSWORD_TOO_LONG":
                return `Password must be at most ${result.userError.maximumLength} characters.`;
              case "PASSWORD_HAS_SURROUNDING_WHITESPACE":
                return "Password can't start or end with whitespace.";
              case "PASSWORD_TOO_COMMON":
                return "This password is one of the most commonly used passwords. Please choose a different one.";
              case "RATE_LIMITED":
                return `Too many attempts. Try again in ${Math.ceil(result.userError.retryAfterMs / 1000)} seconds.`;
              default:
                result.userError satisfies never;
                console.error("Password change failed:", result.userError);
                return "Something went wrong. Please try again.";
            }
          });
        } catch (error) {
          console.error("Change password failed:", error);
          setMessage("Something went wrong. Please try again.");
        } finally {
          setPending(false);
        }
      }}
    >
      <h2>Change password</h2>
      {/* Hidden email, so that password managers know which login to update */}
      <input
        type="email"
        value={currentEmail ?? ""}
        // "username", not "email" (best practice for password manager support)
        autoComplete="username"
        readOnly
        hidden
      />
      <label>
        Current password
        <input
          type="password"
          value={currentPasswordField}
          onChange={(e) => setCurrentPasswordField(e.target.value)}
          autoComplete="current-password"
          required
          disabled={pending}
        />
      </label>
      <label>
        New password
        <input
          type="password"
          value={newPasswordField}
          onChange={(e) => setNewPasswordField(e.target.value)}
          autoComplete="new-password"
          required
          disabled={pending}
        />
      </label>
      {message ? (
        <p role="alert">
          <strong>{message}</strong>
        </p>
      ) : null}
      <button type="submit" disabled={pending}>
        {pending ? "Changing…" : "Change password"}
      </button>
    </form>
  );
}
