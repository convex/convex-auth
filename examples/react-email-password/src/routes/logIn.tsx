import { useSignInWithEmailPassword } from "@convex-dev/auth/methods/email-password/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";

export function LogIn() {
  const { signIn, pending } = useSignInWithEmailPassword(api.auth);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          const result = await signIn({ email, password });
          if (result.status === "complete") {
            return;
          }
          setError(() => {
            switch (result.userError.error) {
              case "USER_NOT_FOUND":
                return "No account exists with that email address. Make sure you validated your email.";
              case "INVALID_CREDENTIALS":
                return "Incorrect email or password.";
              case "PASSWORD_TOO_SHORT":
                return `Password must be at least ${result.userError.minimumLength} characters.`;
              case "PASSWORD_TOO_LONG":
                return `Password must be at most ${result.userError.maximumLength} characters.`;
              case "PASSWORD_HAS_SURROUNDING_WHITESPACE":
                return "Password can't start or end with whitespace.";
              case "RATE_LIMITED":
                return `Too many attempts. Try again in ${Math.ceil(result.userError.retryAfterMs / 1000)} seconds.`;
              case "OTHER_ERROR":
                console.error("Sign-in failed:", result.userError.cause);
                return "Something went wrong. Please try again.";
              default:
                result.userError satisfies never;
                console.error("Sign-in failed:", result.userError);
                return "Something went wrong. Please try again.";
            }
          });
        }}
      >
        <h1>Log in</h1>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            // "username", not "email" (best practice for password manager support)
            autoComplete="username"
            required
            disabled={pending}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
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
          {pending ? "Logging in…" : "Log in"}
        </button>
      </form>
      <p>
        Don't have an account? <a href="/signup">Sign up</a>
      </p>
      <p>
        Forgot your password? <a href="/forgot-password">Reset it</a>
      </p>
    </>
  );
}
