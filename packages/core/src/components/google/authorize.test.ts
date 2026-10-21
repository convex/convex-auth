/**
 * The authorization URL Google's `startSignIn` builds, run against Google's
 * own component.
 *
 * @module
 */
import { api } from "./_generated/api.ts";
import type { ComponentApi } from "./_generated/component.ts";
import schema from "./schema.ts";
import { setupGoogle } from "../../methods/google/server.ts";
import {
  ALLOWED_ORIGINS,
  asComponentApi,
  fakeCore,
  testAuthorizationUrl,
} from "../../lib/oauth/componentContract.test.ts";

const modules = import.meta.glob("./**/*.ts");

const { startSignInWithGoogle } = setupGoogle(fakeCore, {
  component: asComponentApi<ComponentApi>(api),
  allowedRedirectOrigins: ALLOWED_ORIGINS,
});

testAuthorizationUrl(schema, modules, startSignInWithGoogle, {
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  scope: "openid email profile",
});
