/**
 * The authorization URL Apple's `startSignIn` builds, run against Apple's own
 * component.
 *
 * @module
 */
import { api } from "./_generated/api.ts";
import type { ComponentApi } from "./_generated/component.ts";
import schema from "./schema.ts";
import { setupApple } from "../../methods/apple/server.ts";
import {
  ALLOWED_ORIGINS,
  asComponentApi,
  fakeCore,
  testAuthorizationUrl,
} from "../../lib/oauth/componentContract.test.ts";

const modules = import.meta.glob("./**/*.ts");

const { startSignInWithApple } = setupApple(fakeCore, {
  component: asComponentApi<ComponentApi>(api),
  allowedRedirectOrigins: ALLOWED_ORIGINS,
});

testAuthorizationUrl(schema, modules, startSignInWithApple, {
  authorizationEndpoint: "https://appleid.apple.com/auth/authorize",
  scope: "name email",
  responseMode: "form_post",
});
