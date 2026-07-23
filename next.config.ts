import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The vendored fund index is a 2MB JSON import; keep it out of the client
  // bundle by ensuring it's only ever reached from server code.
  serverExternalPackages: ["unpdf"],
};

export default nextConfig;
