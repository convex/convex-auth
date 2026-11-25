import { convexAuthSvelteKitAccessToken } from "$lib/server/convexAuth";
import type { LayoutServerLoad } from "./$types";

// Hands the access token from the cookie to the client, so it starts signed in
// on the first render.
export const load: LayoutServerLoad = (event) => ({
  convexAuthToken: convexAuthSvelteKitAccessToken(event),
});
