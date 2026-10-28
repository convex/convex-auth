"use client";

import {
  ConvexAuthNextjsProvider,
  createNextjsAuthClient,
} from "@convex-dev/auth/ssr/nextjs/client";
import { ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
const auth = createNextjsAuthClient({ convex });

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return (
    <ConvexAuthNextjsProvider auth={auth}>{children}</ConvexAuthNextjsProvider>
  );
}
