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
  fakeCore,
  testAuthorizationUrl,
} from "../../lib/oauth/componentContract.test.ts";

const modules = import.meta.glob("./**/*.ts");

const { startSignInWithGithub } = setupGithub(fakeCore, {
  component: asComponentApi<ComponentApi>(api),
  allowedRedirectOrigins: ALLOWED_ORIGINS,
});

testAuthorizationUrl(schema, modules, startSignInWithGithub, {
  authorizationEndpoint: "https://github.com/login/oauth/authorize",
  scope: "read:user user:email",
});
