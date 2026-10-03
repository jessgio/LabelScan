import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Browser checks open the dev server as 127.0.0.1. Next blocks those
  // dev assets unless this origin is allowed.
  allowedDevOrigins: ['127.0.0.1'],
};

export default nextConfig;
