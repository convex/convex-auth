import { useSignInWithUsernamePassword } from "@convex-dev/auth/methods/username-password/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";

export function LogIn() {
  const { signIn, pending } = useSignInWithUsernamePassword(api.auth);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          const result = await signIn({ username, password });
          if (result.status === "complete") {
            return;
          }
          setError(() => {
            switch (result.userError.error) {
              case "USER_NOT_FOUND":
                return "No account exists with that username.";
              case "INVALID_CREDENTIALS":
                return "Incorrect username or password.";
              case "PASSWORD_TOO_SHORT":
                return `Password must be at least ${result.userError.minimumLength} characters.`;
              case "PASSWORD_TOO_LONG":
                return `Password must be at most ${result.userError.maximumLength} characters.`;
              case "PASSWORD_HAS_SURROUNDING_WHITESPACE":
                return "Password can't start or end with whitespace.";
              case "RATE_LIMITED":
                return `Too many attempts. Try again in ${Math.ceil(result.userError.retryAfterMs / 1000)} seconds.`;
              case "OTHER_ERROR":
                // The mutation threw unexpectedly; the original error is
                // available on `cause` if you want to log or inspect it.
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
        <label htmlFor="username">
          Username
          <input
            // Using a static id to help password managers behave correctly
            id="username"
            name="username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            disabled={pending}
          />
        </label>
        <label htmlFor="password">
          Password
          <input
            // Using a static id to help password managers behave correctly
            id="password"
            name="password"
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
    </>
  );
}
