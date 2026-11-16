import { useSignInWithEmailCode } from "@convex-dev/auth/methods/email-code/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";

// One page for sign-in and sign-up: the first step sends a code, the second
// checks it. A new address gets a new account.
export function SignIn() {
  const { sendCode, signIn, pending } = useSignInWithEmailCode(api.auth);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setError(null);
    const result = await sendCode({ email });
    if (result.success) {
      setSentTo(email);
      setCode("");
      return;
    }
    setError(() => {
      switch (result.userError.error) {
        case "INVALID_EMAIL":
          return "Enter a valid email address.";
        case "RATE_LIMITED":
          return `Too many codes. Try again in ${Math.ceil(result.userError.retryAfterMs / 1000)} seconds.`;
        case "OTHER_ERROR":
          console.error("Sending the code failed:", result.userError.cause);
          return "Something went wrong. Please try again.";
        default:
          result.userError satisfies never;
          console.error("Sending the code failed:", result.userError);
          return "Something went wrong. Please try again.";
      }
    });
  };

  if (sentTo === null) {
    return (
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await send();
        }}
      >
        <h1>Sign in</h1>
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
          {pending ? "Sending…" : "Send code"}
        </button>
      </form>
    );
  }

  return (
    <>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          const result = await signIn({ code });
          if (result.status === "complete") {
            return;
          }
          switch (result.userError.error) {
            case "INCORRECT_CODE":
              setError("That code is wrong. Check the newest email.");
              return;
            case "TOO_MANY_ATTEMPTS":
            case "INVALID_CHALLENGE":
            case "MISSING_SECRET":
              setSentTo(null);
              setError("That code no longer works. Ask for a new one.");
              return;
            case "OTHER_ERROR":
              console.error("Sign-in failed:", result.userError.cause);
              setError("Something went wrong. Please try again.");
              return;
            default:
              result.userError satisfies never;
              console.error("Sign-in failed:", result.userError);
              setError("Something went wrong. Please try again.");
          }
        }}
      >
        <h1>Enter your code</h1>
        <p>We sent a code to {sentTo}.</p>
        <label>
          Code
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
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
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p>
        <button type="button" onClick={send} disabled={pending}>
          Send a new code
        </button>{" "}
        <button
          type="button"
          onClick={() => {
            setSentTo(null);
            setError(null);
          }}
          disabled={pending}
        >
          Use another address
        </button>
      </p>
    </>
  );
}
