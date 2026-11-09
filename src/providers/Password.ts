/**
 * Configure {@link Password} provider given a {@link PasswordConfig}.
 *
 * The `Password` provider supports the following flows, determined
 * by the `flow` parameter:
 *
 * - `"signUp"`: Create a new account with a password.
 * - `"signIn"`: Sign in with an existing account and password.
 * - `"reset"`: Request a password reset.
 * - `"reset-verification"`: Verify a password reset code and change password.
 * - `"email-verification"`: If email verification is enabled and `code` is
 *    included in params, verify an OTP.
 *
 * ```ts
 * import { Password } from "@convex-dev/auth/providers/Password";
 * import { convexAuth } from "@convex-dev/auth/server";
 *
 * export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
 *   providers: [Password],
 * });
 * ```
 *
 * @module
 */

import {
  ConvexCredentials,
  ConvexCredentialsUserConfig,
} from "@convex-dev/auth/providers/ConvexCredentials";
import {
  EmailConfig,
  GenericActionCtxWithAuthConfig,
  GenericDoc,
  createAccount,
  invalidateSessions,
  modifyAccountCredentials,
  retrieveAccount,
  signInViaProvider,
} from "@convex-dev/auth/server";
import {
  DocumentByName,
  GenericDataModel,
  TableNamesInDataModel,
  WithoutSystemFields,
} from "convex/server";
import { Value } from "convex/values";
import { Scrypt } from "lucia";

/**
 * The available options to a {@link Password} provider for Convex Auth.
 */
export interface PasswordConfig<
  DataModel extends GenericDataModel,
  UsersTable extends TableNamesInDataModel<DataModel> = "users",
> {
  /**
   * Uniquely identifies the provider, allowing to use
   * multiple different {@link Password} providers.
   */
  id?: string;
  /**
   * Perform checks on provided params and customize the user
   * information stored after sign up, including email normalization.
   *
   * Called for every flow ("signUp", "signIn", "reset",
   * "reset-verification" and "email-verification").
   */
  profile?: (
    /**
     * The values passed to the `signIn` function.
     */
    params: Record<string, Value | undefined>,
    /**
     * Convex ActionCtx in case you want to read from or write to
     * the database.
     */
    ctx: GenericActionCtxWithAuthConfig<DataModel>,
  ) => WithoutSystemFields<DocumentByName<DataModel, UsersTable>> & {
    email: string;
  };
  /**
   * Performs custom validation on password provided during sign up or reset.
   *
   * Otherwise the default validation is used (password is not empty and
   * at least 8 characters in length).
   *
   * If the provided password is invalid, implementations must throw an Error.
   *
   * @param password the password supplied during "signUp" or
   *                 "reset-verification" flows.
   */
  validatePasswordRequirements?: (password: string) => void;
  /**
   * Provide hashing and verification functions if you want to control
   * how passwords are hashed.
   */
  crypto?: ConvexCredentialsUserConfig["crypto"];
  /**
   * An Auth.js email provider used to require verification
   * before password reset.
   */
  reset?: EmailConfig | ((...args: any) => EmailConfig);
  /**
   * An Auth.js email provider used to require verification
   * before sign up / sign in.
   */
  verify?: EmailConfig | ((...args: any) => EmailConfig);
}

/**
 * Email and password authentication provider.
 *
 * Passwords are by default hashed using Scrypt from Lucia.
 * You can customize the hashing via the `crypto` option.
 *
 * Email verification is not required unless you pass
 * an email provider to the `verify` option.
 */
export function Password<
  DataModel extends GenericDataModel,
  UsersTable extends TableNamesInDataModel<DataModel> = "users",
>(config: PasswordConfig<DataModel, UsersTable> = {}) {
  const provider = config.id ?? "password";
  return ConvexCredentials<DataModel>({
    id: "password",
    authorize: async (params, ctx) => {
      const flow = params.flow as string;
      const passwordToValidate =
        flow === "signUp"
          ? (params.password as string)
          : flow === "reset-verification"
            ? (params.newPassword as string)
            : null;
      if (passwordToValidate !== null) {
        if (config.validatePasswordRequirements !== undefined) {
          config.validatePasswordRequirements(passwordToValidate);
        } else {
          validateDefaultPasswordRequirements(passwordToValidate);
        }
      }
      const profile = config.profile?.(params, ctx) ?? defaultProfile(params);
      const { email } = profile;
      const secret = params.password as string;
      let account: GenericDoc<DataModel, "authAccounts">;
      if (flow === "signUp") {
        if (secret === undefined) {
          throw new Error("Missing `password` param for `signUp` flow");
        }
        const created = await createAccount(ctx, {
          provider,
          account: { id: email, secret },
          profile: profile as any,
          shouldLinkViaEmail: config.verify !== undefined,
          shouldLinkViaPhone: false,
        });
        ({ account } = created);
      } else if (flow === "signIn") {
        if (secret === undefined) {
          throw new Error("Missing `password` param for `signIn` flow");
        }
        const retrieved = await retrieveAccount(ctx, {
          provider,
          account: { id: email, secret },
        });
        if (retrieved === null) {
          throw new Error("Invalid credentials");
        }
        ({ account } = retrieved);
        // START: Optional, support password reset
      } else if (flow === "reset") {
        if (!config.reset) {
          throw new Error(`Password reset is not enabled for ${provider}`);
        }
        const { account } = await retrieveAccount(ctx, {
          provider,
          account: { id: email },
        });
        return await signInViaProvider(ctx, config.reset, {
          accountId: account._id,
          params,
        });
      } else if (flow === "reset-verification") {
        if (!config.reset) {
          throw new Error(`Password reset is not enabled for ${provider}`);
        }
        if (params.newPassword === undefined) {
          throw new Error(
            "Missing `newPassword` param for `reset-verification` flow",
          );
        }
        const { account: resetAccount } = await retrieveAccount(ctx, {
          provider,
          account: { id: email },
        });
        const result = await signInViaProvider(ctx, config.reset, { params });
        if (result === null) {
          throw new Error("Invalid code");
        }
        const { userId, sessionId } = result;
        if (resetAccount.userId !== userId) {
          throw new Error("Invalid code");
        }
        const secret = params.newPassword as string;
        await modifyAccountCredentials(ctx, {
          provider,
          account: { id: email, secret },
        });
        await invalidateSessions(ctx, { userId, except: [sessionId] });
        return { userId, sessionId };
        // END
        // START: Optional, email verification during sign in
      } else if (flow === "email-verification") {
        if (!config.verify) {
          throw new Error(`Email verification is not enabled for ${provider}`);
        }
        const { account } = await retrieveAccount(ctx, {
          provider,
          account: { id: email },
        });
        return await signInViaProvider(ctx, config.verify, {
          accountId: account._id,
          params,
        });
        // END
      } else {
        throw new Error(
          "Missing `flow` param, it must be one of " +
            '"signUp", "signIn", "reset", "reset-verification" or ' +
            '"email-verification"!',
        );
      }
      // START: Optional, email verification during sign in
      if (config.verify && !account.emailVerified) {
        return await signInViaProvider(ctx, config.verify, {
          accountId: account._id,
          params,
        });
      }
      // END
      return { userId: account.userId as string };
    },
    crypto: {
      async hashSecret(password: string) {
        return await new Scrypt().hash(password);
      },
      async verifySecret(password: string, hash: string) {
        return await new Scrypt().verify(hash, password);
      },
    },
    extraProviders: [config.reset, config.verify],
    ...config,
  });
}

function validateDefaultPasswordRequirements(password: string) {
  if (!password || password.length < 8) {
    throw new Error("Invalid password");
  }
}

function defaultProfile(params: Record<string, unknown>) {
  return {
    email: params.email as string,
  };
}
