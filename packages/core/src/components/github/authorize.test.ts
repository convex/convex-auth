/**
 * The authorization URL GitHub's `startSignIn` builds, run against GitHub's
 * own component.
 *
 * @module
 */
import { api } from "./_generated/api.ts";
import type { ComponentApi } from "./_generated/component.ts";
import schema from "./schema.ts";
import { setupGithub } from "../../methods/github/server.ts";
import {
  ALLOWED_ORIGINS,
  asComponentApi,
  fakeCallbacks,
  fakeCore,
  testAuthorizationUrl,
} from "../../lib/oauth/componentContract.fixture.ts";

const modules = import.meta.glob("./**/*.ts");

const { startSignInWithGithub } = setupGithub(fakeCore, {
  component: asComponentApi<ComponentApi>(api),
  allowedRedirectOrigins: ALLOWED_ORIGINS,
}).attachUserCallbacks(fakeCallbacks);

testAuthorizationUrl(schema, modules, startSignInWithGithub, {
  authorizationEndpoint: "https://github.com/login/oauth/authorize",
  scope: "read:user user:email",
});
