/**
 * The authorization URL Discord's `startSignIn` builds, run against Discord's
 * own component.
 *
 * @module
 */
import { api } from "./_generated/api.ts";
import type { ComponentApi } from "./_generated/component.ts";
import schema from "./schema.ts";
import { setupDiscord } from "../../methods/discord/server.ts";
import {
  ALLOWED_ORIGINS,
  asComponentApi,
  fakeCallbacks,
  fakeCore,
  testAuthorizationUrl,
} from "../../lib/oauth/componentContract.fixture.ts";

const modules = import.meta.glob("./**/*.ts");

const { startSignInWithDiscord } = setupDiscord(fakeCore, {
  component: asComponentApi<ComponentApi>(api),
  allowedRedirectOrigins: ALLOWED_ORIGINS,
}).attachUserCallbacks(fakeCallbacks);

testAuthorizationUrl(schema, modules, startSignInWithDiscord, {
  authorizationEndpoint: "https://discord.com/oauth2/authorize",
  scope: "identify email",
  extraParams: { prompt: "none" },
});
