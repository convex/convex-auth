import { convexTest } from "convex-test";
import {
  componentsGeneric,
  internalMutationGeneric,
  makeFunctionReference,
} from "convex/server";
import { v } from "convex/values";
import type { ComponentApi as CoreApi } from "../component/_generated/component.ts";
import type { UsernamePasswordOptions } from "./username-password/server.ts";
import type { EmailPasswordOptions } from "./email-password/server.ts";
import type { UsernamePasskeyOptions } from "./username-passkey/server.ts";
import { setupUsernamePassword } from "./username-password/server.ts";
import { setupEmailPassword } from "./email-password/server.ts";
import { setupUsernamePasskey } from "./username-passkey/server.ts";
import { setupConvexAuth } from "../server/setup.ts";
import { registerCore, sessionIdentity } from "../testing/core.ts";
import { registerPassword } from "../testing/password.ts";
import { registerUsername } from "../testing/username.ts";
import { registerEmail } from "../testing/email.ts";
import { registerPasskey } from "../testing/passkey.ts";
import { resolveTtlConfig } from "../lib/ttl.ts";
import type { CreateUserFn } from "../lib/types.ts";

const components = componentsGeneric() as unknown as {
  auth: CoreApi<"auth">;
  authPassword: UsernamePasswordOptions["component"];
  authUsername: UsernamePasswordOptions["usernameComponent"];
  authEmail: EmailPasswordOptions["component"];
  authPasskey: UsernamePasskeyOptions["component"];
};
const core = setupConvexAuth({ component: components.auth });
const createUser = internalMutationGeneric({
  args: { method: v.any() },
  returns: v.string(),
  handler: async () => crypto.randomUUID(),
});
const callback = makeFunctionReference<"mutation">("testApp:createUser");
const password = setupUsernamePassword(core, {
  component: components.authPassword,
  usernameComponent: components.authUsername,
}).attachUserCallbacks({
  createUser: callback as unknown as CreateUserFn<
    "usernamePassword",
    Record<string, never>,
    "users"
  >,
});
const email = setupEmailPassword(core, {
  component: components.authEmail,
  passwordComponent: components.authPassword,
  emailSender: {
    kind: "resend",
    sendEmail:
      callback as unknown as EmailPasswordOptions["emailSender"]["sendEmail"],
    apiKey: "test",
    from: "test@example.com",
  },
  urls: {
    signUp: "https://example.com/signup",
    changeEmail: "https://example.com/change",
    recovery: "https://example.com/recover",
  },
}).attachUserCallbacks({
  createUser: callback as unknown as CreateUserFn<
    "emailPassword",
    Record<string, never>,
    "users"
  >,
});
const passkey = setupUsernamePasskey(core, {
  component: components.authPasskey,
  usernameComponent: components.authUsername,
  rpId: "example.com",
  origin: "https://example.com",
}).attachUserCallbacks({
  createUser: callback as unknown as CreateUserFn<
    "usernamePasskey",
    Record<string, never>,
    "users"
  >,
});
const testApp = {
  createUser,
  ...password,
  emailChangePassword: email.changePassword,
  startChangeEmail: email.startChangeEmail,
  completeChangeEmail: email.completeChangeEmail,
  startAddPasskey: passkey.startAddPasskey,
  verifyAddPasskey: passkey.verifyAddPasskey,
  finishAddPasskey: passkey.finishAddPasskey,
  renamePasskey: passkey.renamePasskey,
  startRemovePasskey: passkey.startRemovePasskey,
  finishRemovePasskey: passkey.finishRemovePasskey,
};
export async function credentialSessions() {
  const t = convexTest(undefined, {
    "./_generated/api.ts": async () => ({}),
    "./testApp.ts": async () => testApp,
  });
  registerCore(t);
  registerPassword(t);
  registerUsername(t);
  registerEmail(t);
  registerPasskey(t);
  const signup = makeFunctionReference<"mutation">(
    "testApp:signUpWithUsernamePassword",
  );
  const admin = await t.mutation(signup, {
    username: "admin",
    password: "correct horse battery staple",
  });
  const target = await t.mutation(signup, {
    username: "target",
    password: "correct horse battery staple",
  });
  const tokens = await t.run((ctx) =>
    ctx.runMutation(components.auth.public._internal_dangerous_impersonate, {
      impersonatorSessionId: sessionIdentity(admin.tokens).subject,
      targetUserId: target.tokens.userId,
      maxDurationSeconds: 3600,
      ...resolveTtlConfig({}),
    }),
  );
  return {
    normal: t.withIdentity(sessionIdentity(target.tokens)),
    impersonating: t.withIdentity(sessionIdentity(tokens)),
  };
}

export const assertion = {
  id: "missing",
  rawId: "missing",
  type: "public-key" as const,
  response: { clientDataJSON: "", authenticatorData: "", signature: "" },
  clientExtensionResults: {},
};
export const attestation = {
  id: "missing",
  rawId: "missing",
  type: "public-key" as const,
  response: { clientDataJSON: "", attestationObject: "" },
  clientExtensionResults: {},
};
