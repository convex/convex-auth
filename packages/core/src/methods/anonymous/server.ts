import { vSignInComplete, type SignInComplete } from "../../lib/types.ts";
import type { AuthCore } from "../../server/setup.ts";
import { ComponentApi } from "../../components/anonymous/_generated/component.ts";

// TODO: derive this from the component mount path rather than hardcoding it.
const PROVIDER_NAME = "anonymous";

/**
 * An anonymous accounts provider.
 *
 * Useful to establish an authenticated session without requiring a user
 * to provide any credentials.
 *
 * There is no support for allowing a user to return with a previously issued
 * anonymous account.
 *
 * ```ts
 * const auth = setupConvexAuth({ component: components.auth });
 * export const { signOut, refreshSession, isAuthenticated } = auth;
 *
 * export const { signInAnonymously } = setupAnonymous(auth, {
 *   component: components.authAnonymous,
 * });
 * ```
 */
export function setupAnonymous(
  core: AuthCore,
  options: {
    /** The mounted anonymous component (`components.authAnonymous`). */
    component: ComponentApi;
  },
) {
  const { component } = options;

  const { authMutation } = core.bindProvider<
    typeof PROVIDER_NAME,
    Record<string, never>
  >({
    name: PROVIDER_NAME,
  });

  return {
    // Anonymous sign-in cannot fail per-user, so this only ever produces
    // the complete arm. It still returns the shared envelope rather than a
    // bare bundle: that is the shape the SSR auth proxy recognizes (and
    // validates before moving the refresh token into its cookie), and it
    // leaves room for a `userError` arm later without another breaking
    // change.
    signInAnonymously: authMutation({
      args: {},
      returns: vSignInComplete,
      handler: async (ctx): Promise<SignInComplete> => {
        const anonymousId = await ctx.runMutation(
          component.provider.createAnonymousAccount,
          {},
        );
        const tokens = await ctx.convexAuth.completeSignUp({
          providerAccountId: anonymousId,
          profile: {},
        });
        return { status: "complete", tokens };
      },
    }),
  };
}
