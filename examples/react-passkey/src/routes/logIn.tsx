import {
  UsernamePasskeyAutofillError,
  SignInWithUsernamePasskeyResult,
  useSignInWithUsernamePasskey,
} from "@convex-dev/auth/methods/username-passkey/react";
import { useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";

export function LogIn() {
  // While this hook is mounted, the browser also offers stored passkeys in
  // the autocompletion list of the username field below (the field carries
  // autoComplete="username webauthn"). Picking one signs in directly.
  const { signIn, pending, autofill } = useSignInWithUsernamePasskey(api.auth);
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Show autofill failures in the same error area as the modal flow. The
  // most recent failure from either flow wins.
  const { lastError } = autofill;
  useEffect(() => {
    if (lastError !== null) {
      setError(errorMessage(lastError));
    }
  }, [lastError]);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        const result = await signIn({ username });
        if (result.status === "complete") {
          return;
        }
        setError(errorMessage(result.userError));
      }}
    >
      <h1>Log in</h1>
      <p>
        Enter your username. A free username creates a new account with a
        passkey; an existing username asks for its passkey.
      </p>
      <label>
        Username
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username webauthn"
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
        {pending ? "Waiting for your passkey…" : "Continue with a passkey"}
      </button>
    </form>
  );
}

function errorMessage(
  userError:
    | Extract<SignInWithUsernamePasskeyResult, { status: "error" }>["userError"]
    | UsernamePasskeyAutofillError,
): string | null {
  switch (userError.error) {
    case "ALREADY_PENDING":
      // A second submit while the first attempt still runs. That attempt
      // keeps its passkey dialog, so there is nothing to tell the user.
      return null;
    case "USERNAME_TOO_SHORT":
      return `The username must be at least ${userError.minimumLength} characters.`;
    case "USERNAME_HAS_SURROUNDING_WHITESPACE":
      return "The username can't start or end with whitespace.";
    case "USERNAME_HAS_INVALID_CHARACTERS":
      return "The username contains characters that aren't allowed.";
    case "USERNAME_TAKEN":
      // Only returned when someone claimed the username between the two
      // steps of the ceremony.
      return "That username was just taken. Try another one.";
    case "CHALLENGE_EXPIRED":
      return "The sign-in attempt took too long. Please try again.";
    case "UNKNOWN_CREDENTIAL":
      return "This passkey is not registered here.";
    case "PROTOCOL_ERROR":
      // The browser sent something that violates the protocol.
      // This might be caused by a misbehaving client, or by a configuration error.
      // The Convex logs contain more information about the source of the error.
      return "This passkey request could not be verified. Please try again, or contact support if the problem persists.";
    case "PASSKEY_ALREADY_REGISTERED":
      // The authenticator refused to make a second passkey (usually
      // because `excludeCredentials` names one it already holds). The
      // message stays account-neutral: this switch also serves the sign-up
      // flow, where no account exists yet.
      return "This device already holds a passkey for this site. Try signing in with it instead.";
    case "CEREMONY_ABORTED":
      // The most common failure: the user closed the passkey dialog.
      return "Sign-in was cancelled. Please try again.";
    case "WEBAUTHN_UNSUPPORTED":
      return "This browser does not support passkeys.";
    case "OTHER_ERROR":
      // The mutation threw unexpectedly; the original error is available
      // on `cause` if you want to log or inspect it.
      console.error("Sign-in failed:", userError.cause);
      return "Something went wrong. Please try again.";
    default:
      userError satisfies never;
      return `Unknown error: ${JSON.stringify(userError)}`;
  }
}
