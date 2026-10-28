import type { ReactNode } from "react";
import { ConvexAuthNextjsServerProvider } from "@/src/lib/convexAuth";
import { ConvexClientProvider } from "./ConvexClientProvider";

export const metadata = {
  title: "Convex Auth — Next.js SSR",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>
        <ConvexAuthNextjsServerProvider>
          <ConvexClientProvider>{children}</ConvexClientProvider>
        </ConvexAuthNextjsServerProvider>
      </body>
    </html>
  );
}
