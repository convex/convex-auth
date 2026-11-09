import { Suspense, type ReactNode } from "react";
import { ConvexAuthNextjsServerProvider } from "@/src/lib/convexAuth";

export const metadata = {
  title: "Convex Auth — Next.js SSR",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>
        {/* The provider reads the auth cookies, so with Cache Components it
            has to render inside a Suspense boundary. */}
        <Suspense>
          <ConvexAuthNextjsServerProvider>
            {children}
          </ConvexAuthNextjsServerProvider>
        </Suspense>
      </body>
    </html>
  );
}
