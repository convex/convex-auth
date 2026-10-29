"use client";

import { useConvexAuth } from "convex/react";
import { useSignInAnonymously } from "@convex-dev/auth/methods/anonymous/react";
import {
  useOauth,
  useSignInWithGithub,
} from "@convex-dev/auth/methods/github/react";
import { useSignInWithUsernamePassword } from "@convex-dev/auth/methods/username-password/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";

export default function SignIn() {
  // The method's own hook, with no SSR-specific variant. The surrounding
  // ConvexAuthNextjsProvider routes this call through the sign-in route, which
  // moves the minted refresh token into an httpOnly cookie so it never reaches
  // JS. Both functions are listed in `signIn` in src/lib/serverAuth.ts.
  const { signIn, pending } = useSignInWithUsernamePassword(api.auth);
  const { signIn: signInAnonymously } = useSignInAnonymously(api.auth);
  // GitHub sends the user back to this page, where the hook redeems the
  // callback code through the sign-in route. A failure to start comes back
  // from `signInWithGithub`, and a failure after the redirect shows up in
  // `flowError`.
  const { signIn: signInWithGithub } = useSignInWithGithub(api.auth);
  const { flowError } = useOauth();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const router = useRouter();
  // The GitHub sign-in finishes on this page with no submit handler to
  // navigate, so go home once the session is in place.
  useEffect(() => {
    if (isAuthenticated) router.replace("/");
  }, [isAuthenticated, router]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [githubError, setGithubError] = useState<string | null>(null);

  return (
    <main style={{ padding: 24, maxWidth: 640 }}>
      <h1>Sign in</h1>
      <form
        style={{ display: "grid", gap: 12, maxWidth: 320 }}
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          const result = await signIn({ username, password });
          if (result.status === "complete") {
            router.push("/");
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
                // The call failed unexpectedly; the original error is
                // available on `cause` if you want to log or inspect it.
                console.error("Sign-in failed:", result.userError.cause);
                return "Something went wrong. Please try again.";
              default:
                result.userError satisfies never;
                return `Unknown error: ` + result.userError;
            }
          });
        }}
      >
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
        <button type="submit" disabled={pending || isLoading}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p>
        Don't have an account? <Link href="/signup">Sign up</Link>
      </p>
      {flowError !== null && (
        <p role="alert">
          <strong>
            {(() => {
              switch (flowError.error) {
                case "ACCESS_DENIED":
                  return "Sign-in was cancelled.";
                case "EXPIRED":
                  return "That sign-in took too long. Please try again.";
                case "INVALID_FLOW":
                  return "This sign-in can't be completed here. Please try again.";
                case "REJECTED":
                  // Your backend rejected the sign-in with a ConvexError,
                  // and `data` is its data. Show it when it's text for the
                  // user.
                  return typeof flowError.data === "string"
                    ? flowError.data
                    : "Sign-in was declined.";
                case "OTHER_ERROR":
                  // The details are on `cause` if you want to log them.
                  return "Something went wrong during sign-in. Please try again.";
                default:
                  flowError satisfies never;
                  return `Unknown error: ${JSON.stringify(flowError)}`;
              }
            })()}
          </strong>
        </p>
      )}
      {githubError !== null && (
        <p role="alert">
          <strong>{githubError}</strong>
        </p>
      )}
      <p>
        <button
          type="button"
          disabled={pending || isLoading}
          onClick={async () => {
            setGithubError(null);
            const result = await signInWithGithub();
            if (result.status === "redirect") return;
            switch (result.userError.error) {
              case "OTHER_ERROR":
                // The flow couldn't start, e.g. the deployment was
                // unreachable. The original error is on `cause` if you want
                // to log or inspect it.
                console.error(
                  "GitHub sign-in failed to start:",
                  result.userError.cause,
                );
                setGithubError(
                  "Couldn't start GitHub sign-in. Please try again.",
                );
                return;
              default:
                result.userError.error satisfies never;
                setGithubError(`Unknown error: ` + result.userError.error);
            }
          }}
        >
          Continue with GitHub
        </button>
      </p>
      <p>
        Or skip the account:{" "}
        <button
          disabled={pending || isLoading}
          onClick={async () => {
            await signInAnonymously();
            router.push("/");
          }}
        >
          Sign in anonymously
        </button>
      </p>
    </main>
  );
}
