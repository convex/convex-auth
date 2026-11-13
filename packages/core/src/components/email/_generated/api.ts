/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as challenge_addEmail from "../challenge/addEmail.js";
import type * as challenge_changeEmail from "../challenge/changeEmail.js";
import type * as challenge_common from "../challenge/common.js";
import type * as challenge_custom from "../challenge/custom.js";
import type * as challenge_signIn from "../challenge/signIn.js";
import type * as challenge_signUp from "../challenge/signUp.js";
import type * as cleanup from "../cleanup.js";
import type * as helpers from "../helpers.js";
import type * as validation from "../validation.js";
import type * as verifiedEmails from "../verifiedEmails.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  "challenge/addEmail": typeof challenge_addEmail;
  "challenge/changeEmail": typeof challenge_changeEmail;
  "challenge/common": typeof challenge_common;
  "challenge/custom": typeof challenge_custom;
  "challenge/signIn": typeof challenge_signIn;
  "challenge/signUp": typeof challenge_signUp;
  cleanup: typeof cleanup;
  helpers: typeof helpers;
  validation: typeof validation;
  verifiedEmails: typeof verifiedEmails;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
  batchWorker: import("@convex-dev/batch-worker/_generated/component.js").ComponentApi<"batchWorker">;
};
