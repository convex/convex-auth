import { useStartPasswordRecovery } from "@convex-dev/auth/methods/email-password/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";

/** The `/forgot-password` page: send a password-reset link. */
export function RequestReset() {
  const { startPasswordRecovery, pending } = useStartPasswordRecovery(api.auth);
  const [emailField, setEmailField] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  if (sentTo !== null) {
    return (
      <>
        <h1>Check your email</h1>
        <p>
          We sent a password-reset link to <strong>{sentTo}</strong>. The link
          stops working after 10 minutes.
        </p>
        <p>
          Open the link in <strong>this browser</strong>: the link only works in
          the browser you requested it from.
        </p>
      </>
    );
  }

  return (
    <>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          const result = await startPasswordRecovery({ email: emailField });
          if (result.success) {
            setSentTo(result.sentTo);
            return;
          }
          setError(() => {
            switch (result.userError.error) {
              case "INVALID_EMAIL":
                return "That email address doesn't look valid.";
              case "EMAIL_NOT_FOUND":
                return "No account exists with that email address.";
              case "RATE_LIMITED":
                return `Too many attempts. Try again in ${Math.ceil(result.userError.retryAfterMs / 1000)} seconds.`;
              case "OTHER_ERROR":
                console.error("Reset request failed:", result.userError.cause);
                return "Something went wrong. Please try again.";
              default:
                result.userError satisfies never;
                console.error(
                  "Password reset request failed:",
                  result.userError,
                );
                return "Something went wrong. Please try again.";
            }
          });
        }}
      >
        <h1>Reset your password</h1>
        <label>
          Email
          <input
            type="email"
            value={emailField}
            onChange={(e) => setEmailField(e.target.value)}
            autoComplete="username"
            required
            disabled={pending}
          />
        </label>
        {error ? (
          <p role="alert">
            <strong>{error}</strong>
          </p>
        ) : null}
        <button type="submit" disabled={pending}>
          {pending ? "Sending…" : "Send reset link"}
        </button>
      </form>
      <p>
        Remembered your password? <a href="/login">Log in</a>
      </p>
    </>
  );
}
