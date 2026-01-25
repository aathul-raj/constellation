import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Suppress hydration warnings in development
  reactStrictMode: true,

  // Configure external packages that should not be bundled
  serverExternalPackages: ['firebase-admin'],

  // Environment variables to expose to the browser
  env: {
    NEXT_PUBLIC_AWS_REGION: process.env.NEXT_PUBLIC_AWS_REGION || 'us-east-1',
  },
};

export default nextConfig;
