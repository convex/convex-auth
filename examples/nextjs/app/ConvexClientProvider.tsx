"use client";

import { ConvexAuthNextjsProvider } from "@convex-dev/auth/ssr/nextjs/client";
import { ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";

// The app owns the Convex client, so it can be configured here or shared with
// other libraries (e.g. `ConvexQueryClient` from `@convex-dev/react-query`).
const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

// Rendered inside `ConvexAuthNextjsServerProvider` (see layout.tsx), which
// hands down the access token from the cookie. Replaces `ConvexProvider`.
export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return (
    <ConvexAuthNextjsProvider client={convex}>
      {children}
    </ConvexAuthNextjsProvider>
  );
}
