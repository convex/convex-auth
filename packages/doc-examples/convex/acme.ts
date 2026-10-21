import { v, type Infer } from "convex/values";
import type { OauthCatalog } from "@convex-dev/auth/methods/oauth/server";

// An identity provider without a built-in component, for the examples of the
// generic OAuth method.
export const vAcmeProfile = v.object({ id: v.string(), email: v.string() });
export type AcmeProfile = Infer<typeof vAcmeProfile>;

export const acmeCatalog: OauthCatalog<AcmeProfile> = {
  authorizationEndpoint: "https://acme.example.com/oauth/authorize",
  tokenEndpoint: "https://acme.example.com/oauth/token",
  userInfoEndpoints: { user: "https://acme.example.com/api/user" },
  scopes: ["email"],
  profile: (_claims, userInfo) => {
    const user = userInfo?.user as { id: number; email: string };
    return { id: String(user.id), email: user.email };
  },
};
