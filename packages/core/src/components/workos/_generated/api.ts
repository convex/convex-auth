/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as connections from "../connections.js";
import type * as constants from "../constants.js";
import type * as directories from "../directories.js";
import type * as directoryGroups from "../directoryGroups.js";
import type * as directoryUsers from "../directoryUsers.js";
import type * as http from "../http.js";
import type * as mirror from "../mirror.js";
import type * as organizationDomains from "../organizationDomains.js";
import type * as organizations from "../organizations.js";
import type * as portal from "../portal.js";
import type * as provider from "../provider.js";
import type * as reconcile from "../reconcile.js";
import type * as rest from "../rest.js";
import type * as webhook from "../webhook.js";
import type * as wire from "../wire.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  connections: typeof connections;
  constants: typeof constants;
  directories: typeof directories;
  directoryGroups: typeof directoryGroups;
  directoryUsers: typeof directoryUsers;
  http: typeof http;
  mirror: typeof mirror;
  organizationDomains: typeof organizationDomains;
  organizations: typeof organizations;
  portal: typeof portal;
  provider: typeof provider;
  reconcile: typeof reconcile;
  rest: typeof rest;
  webhook: typeof webhook;
  wire: typeof wire;
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

export const components = componentsGeneric() as unknown as {};
