import {
  useSendEmailShortCode,
  useSignInWithEmailShortCode,
  type SendResult,
  type SignInResult,
} from "@convex-dev/auth/methods/email-short-code/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";

/**
 * The one flow of the method, in two steps: the email address, then the
 * code from the email. It serves a person who has an account and a person
 * who has none: the account of a new person is created when they enter the
 * code.
 */
export function SignIn() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  if (sentTo === null) {
    return <EmailStep onSent={setSentTo} />;
  }
  return <CodeStep email={sentTo} onBack={() => setSentTo(null)} />;
}

function EmailStep({ onSent }: { onSent: (email: string) => void }) {
  const { sendCode, pending } = useSendEmailShortCode(api.auth);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        const result = await sendCode({ email });
        if (result.success) {
          onSent(email);
          return;
        }
        setError(sendErrorMessage(result.userError));
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

function CodeStep({ email, onBack }: { email: string; onBack: () => void }) {
  const { signIn, pending } = useSignInWithEmailShortCode(api.auth);
  const { sendCode, pending: resending } = useSendEmailShortCode(api.auth);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setMessage(null);
        const result = await signIn({ code });
        // On success, the auth state changes and the router leaves this
        // page.
        if (result.status === "error") {
          setMessage(signInErrorMessage(result.userError));
        }
      }}
    >
      <h1>Check your email</h1>
      <p>
        We sent a code to <strong>{email}</strong>. It works for 10 minutes, in
        this browser only.
      </p>
      <label>
        Code
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          // Lets the browser offer the code from the email or a message.
          autoComplete="one-time-code"
          inputMode="numeric"
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
        {pending ? "Signing in…" : "Sign in"}
      </button>{" "}
      <button
        type="button"
        disabled={resending}
        onClick={async () => {
          setMessage(null);
          setCode("");
          const result = await sendCode({ email });
          setMessage(
            result.success
              ? "We sent a new code. Only the newest code works."
              : sendErrorMessage(result.userError),
          );
        }}
      >
        Send a new code
      </button>{" "}
      <button type="button" onClick={onBack}>
        Use another address
      </button>
    </form>
  );
}

type SendError = Extract<SendResult, { success: false }>["userError"];

function sendErrorMessage(error: SendError): string {
  switch (error.error) {
    case "INVALID_EMAIL":
      return "That email address doesn't look valid.";
    case "RATE_LIMITED":
      return `Too many attempts. Try again in ${minutes(error.retryAfterMs)}.`;
    case "OTHER_ERROR":
      console.error("Could not send the code:", error.cause);
      return "Something went wrong. Please try again.";
    default:
      error satisfies never;
      return "Something went wrong. Please try again.";
  }
}

type SignInError = Extract<SignInResult, { status: "error" }>["userError"];

function signInErrorMessage(error: SignInError): string {
  switch (error.error) {
    case "INCORRECT_CODE":
      return error.attemptsLeft > 0
        ? `That code is not correct. You can try ${error.attemptsLeft} more ` +
            `time${error.attemptsLeft === 1 ? "" : "s"}.`
        : "That code is not correct, and you have no attempts left. Send a new code.";
    case "RATE_LIMITED":
      return `Too many incorrect codes. Try again in ${minutes(error.retryAfterMs)}.`;
    case "INVALID_CHALLENGE":
      return "This code is no longer valid. It may have expired. Send a new code.";
    case "MISSING_SECRET":
      // This browser has no sign-in in progress, for example because its
      // storage was cleared.
      return "This browser did not ask for a code. Send a new code.";
    case "OTHER_ERROR":
      console.error("Sign-in failed:", error.cause);
      return "Something went wrong. Please try again.";
    default:
      error satisfies never;
      return "Something went wrong. Please try again.";
  }
}

function minutes(ms: number): string {
  const n = Math.ceil(ms / 60_000);
  return `${n} minute${n === 1 ? "" : "s"}`;
}
