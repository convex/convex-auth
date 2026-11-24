<script lang="ts">
  import { goto } from "$app/navigation";
  import {
    useOauth,
    useSignInWithGithub,
  } from "@convex-dev/auth/methods/github/svelte";
  import {
    useSignInWithUsernamePassword,
    type SignInWithUsernamePasswordResult,
  } from "@convex-dev/auth/methods/username-password/svelte";
  import { useAuth } from "convex-svelte";
  import { api } from "../../../convex/_generated/api";

  // The method's own hook, with no SSR-specific variant. The surrounding
  // setupConvexAuthSvelteKit routes this call through the sign-in route, which
  // moves the minted refresh token into an httpOnly cookie so it never reaches
  // JS. Its function is listed in `signIn` in src/lib/server/serverAuth.ts.
  const login = useSignInWithUsernamePassword(api.auth);
  // GitHub sends the user back to this page, where the hook redeems the
  // callback code through the sign-in route. A failure to start comes back
  // from `github.signIn`, and a failure after the redirect shows up in
  // `oauthState.flowError`.
  const github = useSignInWithGithub(api.auth);
  const oauthState = useOauth();
  const auth = useAuth();
  // The GitHub sign-in finishes on this page with no submit handler to
  // navigate, so go home once the session is in place.
  $effect(() => {
    if (auth.isAuthenticated) void goto("/", { replaceState: true });
  });
  let username = $state("");
  let password = $state("");
  let error = $state<string | null>(null);
  let githubError = $state<string | null>(null);

  function message(
    userError: Extract<
      SignInWithUsernamePasswordResult,
      { status: "error" }
    >["userError"],
  ): string {
    switch (userError.error) {
      case "USER_NOT_FOUND":
        return "No account exists with that username.";
      case "INVALID_CREDENTIALS":
        return "Incorrect username or password.";
      case "PASSWORD_TOO_SHORT":
        return `Password must be at least ${userError.minimumLength} characters.`;
      case "PASSWORD_TOO_LONG":
        return `Password must be at most ${userError.maximumLength} characters.`;
      case "PASSWORD_HAS_SURROUNDING_WHITESPACE":
        return "Password can't start or end with whitespace.";
      case "RATE_LIMITED":
        return `Too many attempts. Try again in ${Math.ceil(userError.retryAfterMs / 1000)} seconds.`;
      case "OTHER_ERROR":
        // The call failed unexpectedly; the original error is available on
        // `cause` if you want to log or inspect it.
        console.error("Sign-in failed:", userError.cause);
        return "Something went wrong. Please try again.";
      default:
        userError satisfies never;
        return `Unknown error: ` + userError;
    }
  }

  const flowErrorMessage = $derived.by(() => {
    const flowError = oauthState.flowError;
    if (flowError === null) return null;
    switch (flowError.error) {
      case "ACCESS_DENIED":
        return "Sign-in was cancelled.";
      case "EXPIRED":
        return "That sign-in took too long. Please try again.";
      case "INVALID_FLOW":
        return "This sign-in can't be completed here. Please try again.";
      case "OTHER_ERROR":
        // The details are on `cause` if you want to log them.
        return "Something went wrong during sign-in. Please try again.";
      default:
        flowError satisfies never;
        return `Unknown error: ${JSON.stringify(flowError)}`;
    }
  });

  async function onsubmit(event: SubmitEvent) {
    event.preventDefault();
    error = null;
    const result = await login.signIn({ username, password });
    if (result.status === "complete") {
      await goto("/");
      return;
    }
    error = message(result.userError);
  }

  async function signInWithGithub() {
    githubError = null;
    const result = await github.signIn();
    if (result.status === "redirect") return;
    switch (result.userError.error) {
      case "OTHER_ERROR":
        // The flow couldn't start, e.g. the deployment was unreachable. The
        // original error is on `cause` if you want to log or inspect it.
        console.error("GitHub sign-in failed to start:", result.userError.cause);
        githubError = "Couldn't start GitHub sign-in. Please try again.";
        return;
      default:
        result.userError.error satisfies never;
        githubError = `Unknown error: ` + result.userError.error;
    }
  }
</script>

<main style="padding: 24px; max-width: 640px">
  <h1>Sign in</h1>
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
        disabled={login.pending}
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
        autocomplete="current-password"
        required
        disabled={login.pending}
      />
    </label>
    {#if error}
      <p role="alert"><strong>{error}</strong></p>
    {/if}
    <button type="submit" disabled={login.pending || auth.isLoading}>
      {login.pending ? "Signing in…" : "Sign in"}
    </button>
  </form>
  <p>Don't have an account? <a href="/signup">Sign up</a></p>
  {#if flowErrorMessage !== null}
    <p role="alert"><strong>{flowErrorMessage}</strong></p>
  {/if}
  {#if githubError !== null}
    <p role="alert"><strong>{githubError}</strong></p>
  {/if}
  <p>
    <button
      type="button"
      disabled={login.pending || auth.isLoading}
      onclick={signInWithGithub}
    >
      Continue with GitHub
    </button>
  </p>
</main>
