import type { AuthConfig } from "convex/server";
import { env } from "./_generated/server";

export default {
  providers: [
    {
      type: "customJwt",
      applicationID: "convex",
      issuer: `${env.CONVEX_CLOUD_URL}/components/auth`,
      jwks: `${env.CONVEX_CLOUD_URL}/.well-known/jwks.json`,
      algorithm: "ES256",
    },
  ],
} satisfies AuthConfig;
