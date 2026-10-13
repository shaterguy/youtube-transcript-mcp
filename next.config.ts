import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/mcp": ["./vendor/yt-dlp_linux"],
  },
};

export default nextConfig;
