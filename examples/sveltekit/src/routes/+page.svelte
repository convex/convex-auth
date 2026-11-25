<script lang="ts">
  import { goto } from "$app/navigation";
  import { useAuthActions, useAuthToken } from "@convex-dev/auth/svelte";
  import { useQuery } from "convex-svelte";
  import { api } from "../../convex/_generated/api";

  let { data } = $props();

  // Rendered on the server from the load function, then kept live.
  const user = useQuery(api.users.loggedInUser, {}, () => ({
    initialData: data.user,
  }));
  const token = useAuthToken();
  const { signOut } = useAuthActions();
</script>

<main style="padding: 24px; max-width: 640px">
  <h1>SvelteKit SSR + Convex Auth</h1>
  <p>
    Signed in as <strong>{user.data?.name ?? "(loading)"}</strong> (user
    <code>{user.data?.id ?? "…"}</code>).
  </p>
  <p style="color: #666">
    Access token (JS-readable):
    <code>{token.current?.slice(0, 24) ?? "none"}…</code>
    <br />
    The refresh token is in an httpOnly cookie — it is never in JS.
  </p>
  <button
    onclick={async () => {
      await signOut();
      await goto("/signin");
    }}
  >
    Sign out
  </button>
</main>
