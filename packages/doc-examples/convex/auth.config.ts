import type { AuthConfig } from "convex/server";
import { convexAuthProvider } from "@convex-dev/auth/server";

export default {
  providers: [convexAuthProvider()],
} satisfies AuthConfig;
