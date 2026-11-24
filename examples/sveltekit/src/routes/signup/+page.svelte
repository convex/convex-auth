<script lang="ts">
  import { goto } from "$app/navigation";
  import { DEFAULT_MIN_PASSWORD_LENGTH } from "@convex-dev/auth/methods/username-password";
  import {
    useSignUpWithUsernamePassword,
    type SignUpWithUsernamePasswordResult,
  } from "@convex-dev/auth/methods/username-password/svelte";
  import { api } from "../../../convex/_generated/api";

  // The sign-up counterpart of /signin, and likewise the method's own hook:
  // the auth proxy creates the account server-side and mints the session the
  // same way. Read `registration.pending` rather than destructuring it, so the
  // template updates when it changes.
  const registration = useSignUpWithUsernamePassword(api.auth);
  let username = $state("");
  let password = $state("");
  let error = $state<string | null>(null);

  function message(
    userError: Extract<
      SignUpWithUsernamePasswordResult,
      { status: "error" }
    >["userError"],
  ): string {
    switch (userError.error) {
      case "USERNAME_TAKEN":
        return "That username is already taken.";
      case "USERNAME_TOO_SHORT":
      case "USERNAME_TOO_LONG":
      case "USERNAME_HAS_SURROUNDING_WHITESPACE":
      case "USERNAME_HAS_INVALID_CHARACTERS":
        return "That username is invalid";
      case "PASSWORD_TOO_SHORT":
        return `Password must be at least ${userError.minimumLength} characters.`;
      case "PASSWORD_TOO_LONG":
        return `Password must be at most ${userError.maximumLength} characters.`;
      case "PASSWORD_HAS_SURROUNDING_WHITESPACE":
        return "Password can't start or end with whitespace.";
      case "PASSWORD_TOO_COMMON":
        return "This password is one of the most commonly used passwords. Please choose a different one.";
      case "OTHER_ERROR":
        // The call failed unexpectedly; the original error is available on
        // `cause` if you want to log or inspect it.
        console.error("Sign-up failed:", userError.cause);
        return "Something went wrong. Please try again.";
      default:
        userError satisfies never;
        return `Unknown error: ` + userError;
    }
  }

  async function onsubmit(event: SubmitEvent) {
    event.preventDefault();
    error = null;
    const result = await registration.signUp({ username, password });
    if (result.status === "complete") {
      await goto("/");
      return;
    }
    error = message(result.userError);
  }
</script>

<main style="padding: 24px; max-width: 640px">
  <h1>Sign up</h1>
  <form style="display: grid; gap: 12px; max-width: 320px" {onsubmit}>
    <label for="username">
      Username
      <!-- Using a static id to help password managers behave correctly -->
      <input
        id="username"
        name="username"
        type="text"
        bind:value={username}
        autocomplete="username"
        required
        disabled={registration.pending}
      />
    </label>
    <label for="password">
      Password
      <!-- Using a static id to help password managers behave correctly -->
      <input
        id="password"
        name="password"
        type="password"
        bind:value={password}
        autocomplete="new-password"
        minlength={DEFAULT_MIN_PASSWORD_LENGTH}
        required
        disabled={registration.pending}
      />
    </label>
    {#if error}
      <p role="alert"><strong>{error}</strong></p>
    {/if}
    <button type="submit" disabled={registration.pending}>
      {registration.pending ? "Creating account…" : "Create account"}
    </button>
  </form>
  <p>Already have an account? <a href="/signin">Sign in</a></p>
</main>
