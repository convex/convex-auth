<script lang="ts">
  import { setupConvexAuthSvelteKit } from "@convex-dev/auth/ssr/sveltekit/client";
  import { PUBLIC_CONVEX_URL } from "$env/static/public";
  import { onMount } from "svelte";
  import { api } from "../../convex/_generated/api";

  let { children, data } = $props();

  // In place of `setupConvex`: it creates the Convex client and hydrates the
  // session from the access token of the layout load. The refresh token stays
  // in its httpOnly cookie, and the client refreshes through /auth/refresh.
  setupConvexAuthSvelteKit({
    convexUrl: PUBLIC_CONVEX_URL,
    initialToken: () => data.convexAuthToken,
    api: api.auth,
  });

  // Lets the e2e tests wait until the page reacts to clicks.
  onMount(() => {
    document.documentElement.dataset.hydrated = "";
  });
</script>

<svelte:head>
  <title>Convex Auth — SvelteKit SSR</title>
</svelte:head>

{@render children()}
