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
  fakeCallbacks,
  fakeCore,
  testAuthorizationUrl,
} from "../../lib/oauth/componentContract.fixture.ts";

const modules = import.meta.glob("./**/*.ts");

const { startSignInWithGoogle } = setupGoogle(fakeCore, {
  component: asComponentApi<ComponentApi>(api),
  allowedRedirectOrigins: ALLOWED_ORIGINS,
}).attachUserCallbacks(fakeCallbacks);

testAuthorizationUrl(schema, modules, startSignInWithGoogle, {
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  scope: "openid email profile",
});
