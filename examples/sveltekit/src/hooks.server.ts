import { redirect } from "@sveltejs/kit";
import { convexAuthSvelteKitHandle } from "$lib/server/convexAuth";

// Refreshes the session up front, so load functions see a current token, and
// redirects based on whether the request is signed in. The handle hook skips
// the /auth routes, which set their own cookies.
export const handle = convexAuthSvelteKitHandle(
  async (event, { isAuthenticated }) => {
    const isAuthPage = ["/signin", "/signup"].includes(event.url.pathname);
    const authed = await isAuthenticated();
    if (!isAuthPage && !authed) {
      redirect(307, "/signin");
    }
    if (isAuthPage && authed) {
      redirect(307, "/");
    }
  },
);
