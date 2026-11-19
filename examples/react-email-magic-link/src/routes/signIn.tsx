import { useSendEmailMagicLink } from "@convex-dev/auth/methods/email-magic-link/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";

/**
 * The one form of the method. It serves a person who has an account and a
 * person who has none: both receive a link, and the account of a new person
 * is created when they open it.
 */
export function SignIn() {
  const { sendMagicLink, pending } = useSendEmailMagicLink(api.auth);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  if (sentTo !== null) {
    return (
      <>
        <h1>Check your email</h1>
        <p>
          We sent a sign-in link to <strong>{sentTo}</strong>. It works for 10
          minutes.
        </p>
        <p>
          Open the link in <strong>this browser</strong>: the link only works in
          the browser you started from.
        </p>
        <button onClick={() => setSentTo(null)}>Use another address</button>
      </>
    );
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        const result = await sendMagicLink({ email });
        if (result.success) {
          setSentTo(email);
          return;
        }
        setError(() => {
          switch (result.userError.error) {
            case "INVALID_EMAIL":
              return "That email address doesn't look valid.";
            case "RATE_LIMITED":
              return `Too many attempts. Try again in ${Math.ceil(result.userError.retryAfterMs / 60_000)} minutes.`;
            case "OTHER_ERROR":
              console.error("Sign-in failed:", result.userError.cause);
              return "Something went wrong. Please try again.";
            default:
              result.userError satisfies never;
              return "Something went wrong. Please try again.";
          }
        });
      }}
    >
      <h1>Sign in or create an account</h1>
      <label>
        Email
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
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
        {pending ? "Sending…" : "Continue with email"}
      </button>
    </form>
  );
}
