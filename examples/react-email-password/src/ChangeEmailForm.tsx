import { useStartChangeEmail } from "@convex-dev/auth/methods/email-password/react";
import { useState } from "react";
import { api } from "../convex/_generated/api";

export function ChangeEmailForm({
  currentEmail,
}: {
  currentEmail: string | undefined;
}) {
  const { startChangeEmail, pending } = useStartChangeEmail(api.auth);
  const [newEmailField, setNewEmailField] = useState("");
  const [currentPasswordField, setCurrentPasswordField] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setMessage(null);
        const result = await startChangeEmail({
          newEmail: newEmailField,
          currentPassword: currentPasswordField,
        });
        if (result.success) {
          setMessage(
            `We sent a link to ${newEmailField}. Open it in this browser to ` +
              "confirm the change.",
          );
          return;
        }
        setMessage(() => {
          switch (result.userError.error) {
            case "NOT_LOGGED_IN":
              return "You are not logged in.";
            case "INVALID_CREDENTIALS":
              return "The current password is incorrect.";
            case "INVALID_EMAIL":
              return "That email address doesn't look valid.";
            case "EMAIL_TAKEN":
              return "An account already exists with that email address.";
            case "PASSWORD_TOO_SHORT":
              return `Password must be at least ${result.userError.minimumLength} characters.`;
            case "PASSWORD_TOO_LONG":
              return `Password must be at most ${result.userError.maximumLength} characters.`;
            case "PASSWORD_HAS_SURROUNDING_WHITESPACE":
              return "Password can't start or end with whitespace.";
            case "RATE_LIMITED":
              return `Too many attempts. Try again in ${Math.ceil(result.userError.retryAfterMs / 1000)} seconds.`;
            case "OTHER_ERROR":
              console.error("Change email failed:", result.userError.cause);
              return "Something went wrong. Please try again.";
            default:
              result.userError satisfies never;
              console.error("Email change failed:", result.userError);
              return "Something went wrong. Please try again.";
          }
        });
      }}
    >
      <h2>Change email</h2>
      {/* Hidden email, so that password managers know which account to update */}
      <input
        type="hidden"
        name="username"
        value={currentEmail ?? ""}
        autoComplete="username"
      />
      <label htmlFor="new-email">New email</label>
      <input
        id="new-email"
        name="new-email"
        type="email"
        value={newEmailField}
        onChange={(e) => setNewEmailField(e.target.value)}
        autoComplete="off"
        required
        disabled={pending}
      />
      <label htmlFor="current-password">Current password</label>
      <input
        id="current-password"
        name="current-password"
        type="password"
        value={currentPasswordField}
        onChange={(e) => setCurrentPasswordField(e.target.value)}
        autoComplete="current-password"
        required
        disabled={pending}
      />
      {message ? (
        <p role="alert">
          <strong>{message}</strong>
        </p>
      ) : null}
      <button type="submit" disabled={pending}>
        {pending ? "Sending…" : "Send confirmation link"}
      </button>
    </form>
  );
}
