import type { NextConfig } from "next";

// `create-next-app` turns on Cache Components by default; the example does
// too, so it builds with the same settings as a new app.
const nextConfig: NextConfig = {
  cacheComponents: true,
};

export default nextConfig;
