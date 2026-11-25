import { PUBLIC_CONVEX_URL } from "$env/static/public";
import { createConvexHttpClient } from "convex-svelte/sveltekit";
import { api } from "../../convex/_generated/api";
import type { PageServerLoad } from "./$types";

// Load the authenticated query on the server, so the page renders signed-in on
// first paint (SSR). The handle hook runs the request with the session's access
// token, so this client is authenticated as the signed-in user.
export const load: PageServerLoad = async () => {
  const client = createConvexHttpClient({ url: PUBLIC_CONVEX_URL });
  return { user: await client.query(api.users.loggedInUser, {}) };
};
