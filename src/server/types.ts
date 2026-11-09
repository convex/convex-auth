import {
  Provider as AuthjsProviderConfig,
  CredentialsConfig,
  EmailConfig as AuthjsEmailConfig,
  OAuth2Config,
  OIDCConfig,
} from "@auth/core/providers";
import { Theme } from "@auth/core/types";
import {
  AnyDataModel,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import { GenericId, JSONValue, Value } from "convex/values";
import { ConvexCredentialsUserConfig } from "../providers/ConvexCredentials.js";
import { GenericDoc } from "./convex_types.js";

/**
 * The config for the Convex Auth library, passed to `convexAuth`.
 */
export type ConvexAuthConfig<UserId extends string = GenericId<"users">> = {
  /**
   * A list of authentication provider configs.
   *
   * You can import existing configs from
   * - `@auth/core/providers/<provider-name>`
   * - `@convex-dev/auth/providers/<provider-name>`
   */
  providers: AuthProviderConfig[];
  /**
   * Theme used for emails.
   * See [Auth.js theme docs](https://authjs.dev/reference/core/types#theme).
   */
  theme?: Theme;
  /**
   * Session configuration.
   */
  session?: {
    /**
     * How long can a user session last without the user reauthenticating.
     *
     * Defaults to 30 days.
     */
    totalDurationMs?: number;
    /**
     * How long can a user session last without the user being active.
     *
     * Defaults to 30 days.
     */
    inactiveDurationMs?: number;
  };
  /**
   * JWT configuration.
   */
  jwt?: {
    /**
     * How long is the JWT valid for after it is signed initially.
     *
     * Defaults to 1 hour.
     */
    durationMs?: number;
    /**
     * Add custom claims to the JWT token.
     *
     * The returned record is spread into the JWT payload alongside the
     * standard `sub` claim. The claims will be available on the
     * `UserIdentity` returned by `ctx.auth.getUserIdentity()`.
     *
     * Reserved claim names (`sub`, `iss`, `aud`, `iat`, `exp`, `nbf`, `jti`)
     * must not be returned — an error will be thrown if they are.
     *
     * ```ts
     * export const { auth, signIn, signOut, store } = convexAuth({
     *   providers: [Google],
     *   jwt: {
     *     customClaims: async (ctx, { userId }) => {
     *       const user = await ctx.db.get(userId);
     *       return { app_user_id: user?.app_user_id };
     *     },
     *   },
     * });
     * ```
     */
    customClaims?: (
      ctx: GenericQueryCtx<AnyDataModel>,
      args: {
        userId: GenericId<"users">;
        sessionId: GenericId<"authSessions">;
      },
    ) => Promise<Record<string, JSONValue | undefined>>;
  };
  /**
   * Sign-in configuration.
   */
  signIn?: {
    /**
     * How many times can the user fail to provide the correct credentials
     * (password, OTP) per hour.
     *
     * Defaults to 10 times per hour (that is 10 failed attempts, and then
     * allow another one every 6 minutes).
     */
    maxFailedAttempsPerHour?: number;
  };
  callbacks?: {
    /**
     * Control which URLs are allowed as a destination after OAuth sign-in
     * and for magic links:
     *
     * ```ts
     * import GitHub from "@auth/core/providers/github";
     * import { convexAuth } from "@convex-dev/auth/server";
     *
     * export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
     *   providers: [GitHub],
     *   callbacks: {
     *     async redirect({ redirectTo }) {
     *       // Check that `redirectTo` is valid
     *       // and return the relative or absolute URL
     *       // to redirect to.
     *     },
     *   },
     * });
     * ```
     *
     * Convex Auth performs redirect only during OAuth sign-in. By default,
     * it redirects back to the URL specified via the `SITE_URL` environment
     * variable. Similarly magic links link to `SITE_URL`.
     *
     * You can customize that behavior by providing a `redirectTo` param
     * to the `signIn` function:
     *
     * ```ts
     * signIn("google", { redirectTo: "/dashboard" })
     * ```
     *
     * You can even redirect to a different site.
     *
     * This callback, if specified, is then called with the provided
     * `redirectTo` param. Otherwise, only query params, relative paths
     * and URLs starting with `SITE_URL` are allowed.
     */
    redirect?: (params: {
      /**
       * The param value passed to the `signIn` function.
       */
      redirectTo: string;
    }) => Promise<string>;
    /**
     * Completely control account linking via this callback.
     *
     * This callback is called during the sign-in process,
     * before account creation and token generation.
     * If specified, this callback is responsible for creating
     * or updating the user document.
     *
     * For "credentials" providers, the callback is only called
     * when `createAccount` is called.
     */
    createOrUpdateUser?: (
      ctx: GenericMutationCtx<AnyDataModel>,
      args: {
        /**
         * If this is a sign-in to an existing account,
         * this is the existing user ID linked to that account.
         */
        existingUserId: UserId | null;
        /**
         * The provider type or "verification" if this callback is called
         * after an email or phone token verification.
         */
        type: "oauth" | "credentials" | "email" | "phone" | "verification";
        /**
         * The provider used for the sign-in, or the provider
         * tied to the account which is having the email or phone verified.
         */
        provider: AuthProviderMaterializedConfig;
        /**
         * - The profile returned by the OAuth provider's `profile` method.
         * - The profile passed to `createAccount` from a ConvexCredentials
         * config.
         * - The email address to which an email will be sent.
         * - The phone number to which a text will be sent.
         */
        profile: Record<string, unknown> & {
          email?: string;
          phone?: string;
          emailVerified?: boolean;
          phoneVerified?: boolean;
        };
        /**
         * The `shouldLink` argument passed to `createAccount`.
         */
        shouldLink?: boolean;
      },
    ) => Promise<UserId>;
    /**
     * Called before a new session is created for a user.
     *
     * This callback runs during every sign-in flow
     * (credentials, OAuth, email, phone) right before the session
     * is persisted. Throw an error to reject the sign-in.
     *
     * This is useful for checking whether a user is banned or
     * otherwise disallowed from signing in:
     *
     * ```ts
     * callbacks: {
     *   async beforeSessionCreation(ctx, { userId }) {
     *     const user = await ctx.db.get(userId);
     *     if (user?.banned) {
     *       throw new Error("Account is banned");
     *     }
     *   },
     * }
     * ```
     */
    beforeSessionCreation?: (
      ctx: GenericMutationCtx<AnyDataModel>,
      args: {
        /**
         * The ID of the user about to be signed in.
         */
        userId: GenericId<"users">;
      },
    ) => Promise<void>;
    /**
     * Perform additional writes after a user is created.
     *
     * This callback is called during the sign-in process,
     * after the user is created or updated,
     * before account creation and token generation.
     *
     * **This callback is only called if `createOrUpdateUser`
     * is not specified.** If `createOrUpdateUser` is specified,
     * you can perform any additional writes in that callback.
     *
     * For "credentials" providers, the callback is only called
     * when `createAccount` is called.
     */
    afterUserCreatedOrUpdated?: (
      ctx: GenericMutationCtx<AnyDataModel>,
      args: {
        /**
         * The ID of the user that is being signed in.
         */
        userId: UserId;
        /**
         * If this is a sign-in to an existing account,
         * this is the existing user ID linked to that account.
         */
        existingUserId: UserId | null;
        /**
         * The provider type or "verification" if this callback is called
         * after an email or phone token verification.
         */
        type: "oauth" | "credentials" | "email" | "phone" | "verification";
        /**
         * The provider used for the sign-in, or the provider
         * tied to the account which is having the email or phone verified.
         */
        provider: AuthProviderMaterializedConfig;
        /**
         * - The profile returned by the OAuth provider's `profile` method.
         * - The profile passed to `createAccount` from a ConvexCredentials
         * config.
         * - The email address to which an email will be sent.
         * - The phone number to which a text will be sent.
         */
        profile: Record<string, unknown> & {
          email?: string;
          phone?: string;
          emailVerified?: boolean;
          phoneVerified?: boolean;
        };
        /**
         * The `shouldLink` argument passed to `createAccount`.
         */
        shouldLink?: boolean;
      },
    ) => Promise<void>;
  };
};

/**
 * Same as Auth.js provider configs, but adds phone provider
 * for verification via SMS or another phone-number-connected messaging
 * service.
 */
export type AuthProviderConfig =
  | Exclude<
      AuthjsProviderConfig,
      CredentialsConfig | ((...args: any) => CredentialsConfig)
    >
  | ConvexCredentialsConfig
  | ((...args: any) => ConvexCredentialsConfig)
  | PhoneConfig
  | ((...args: any) => PhoneConfig);

/**
 * Extends the standard Auth.js email provider config
 * to allow additional checks during token verification.
 */
export interface EmailConfig<
  DataModel extends GenericDataModel = GenericDataModel,
> extends AuthjsEmailConfig {
  /**
   * Before the token is verified, check other
   * provided parameters.
   *
   * Used to make sure tha OTPs are accompanied
   * with the correct email address.
   */
  authorize?: (
    /**
     * The values passed to the `signIn` function.
     */
    params: Record<string, Value | undefined>,
    account: GenericDoc<DataModel, "authAccounts">,
  ) => Promise<void>;
}

/**
 * Configurable options for an email provider config.
 */
export type EmailUserConfig<
  DataModel extends GenericDataModel = GenericDataModel,
> = Omit<Partial<EmailConfig<DataModel>>, "options" | "type">;

/**
 * Same as email provider config, but verifies
 * phone number instead of the email address.
 */
export interface PhoneConfig<
  DataModel extends GenericDataModel = GenericDataModel,
> {
  id: string;
  type: "phone";
  /**
   * Token expiration in seconds.
   */
  maxAge: number;
  /**
   * Send the phone number verification request.
   */
  sendVerificationRequest: (
    params: {
      identifier: string;
      url: string;
      expires: Date;
      provider: PhoneConfig;
      token: string;
    },
    ctx: GenericActionCtxWithAuthConfig<DataModel>,
  ) => Promise<void>;
  /**
   * Defaults to `process.env.AUTH_<PROVIDER_ID>_KEY`.
   */
  apiKey?: string;
  /**
   * Override this to generate a custom token.
   * Note that the tokens are assumed to be cryptographically secure.
   * Any tokens shorter than 24 characters are assumed to not
   * be secure enough on their own, and require providing
   * the original `phone` used in the initial `signIn` call.
   * @returns
   */
  generateVerificationToken?: () => Promise<string>;
  /**
   * Normalize the phone number.
   * @param identifier Passed as `phone` in params of `signIn`.
   * @returns The phone number used in `sendVerificationRequest`.
   */
  normalizeIdentifier?: (identifier: string) => string;
  /**
   * Before the token is verified, check other
   * provided parameters.
   *
   * Used to make sure tha OTPs are accompanied
   * with the correct phone number.
   */
  authorize?: (
    /**
     * The values passed to the `signIn` function.
     */
    params: Record<string, Value | undefined>,
    account: GenericDoc<DataModel, "authAccounts">,
  ) => Promise<void>;
  options: PhoneUserConfig<DataModel>;
}

/**
 * Configurable options for a phone provider config.
 */
export type PhoneUserConfig<
  DataModel extends GenericDataModel = GenericDataModel,
> = Omit<Partial<PhoneConfig<DataModel>>, "options" | "type">;

/**
 * Similar to Auth.js Credentials config.
 */
export type ConvexCredentialsConfig<
  DataModel extends GenericDataModel = GenericDataModel,
> = ConvexCredentialsUserConfig<DataModel> & {
  type: "credentials";
  id: string;
};

/**
 * Your `ActionCtx` enriched with `ctx.auth.config` field with
 * the config passed to `convexAuth`.
 */
export type GenericActionCtxWithAuthConfig<DataModel extends GenericDataModel> =
  GenericActionCtx<DataModel> & {
    auth: { config: ConvexAuthMaterializedConfig };
  };

/**
 * The config for the Convex Auth library, passed to `convexAuth`,
 * with defaults and initialized providers.
 *
 * See {@link ConvexAuthConfig}
 */
export type ConvexAuthMaterializedConfig = {
  providers: AuthProviderMaterializedConfig[];
  theme: Theme;
} & Pick<ConvexAuthConfig, "session" | "jwt" | "signIn" | "callbacks">;

/**
 * Materialized Auth.js provider config.
 */
export type AuthProviderMaterializedConfig =
  | OIDCConfig<any>
  | OAuth2Config<any>
  | EmailConfig
  | PhoneConfig
  | ConvexCredentialsConfig;
