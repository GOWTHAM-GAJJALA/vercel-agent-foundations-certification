import { withWorkflow } from "workflow/next";

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    // The project type-checks cleanly; fail the build on any type error.
    ignoreBuildErrors: false,
  },
  serverExternalPackages: ["@vercel/oidc"],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.public.blob.vercel-storage.com",
      },
      {
        protocol: "https",
        hostname: "**.vercel-storage.com",
      },
    ],
  },
};

// withWorkflow compiles "use workflow" / "use step" functions.
export default withWorkflow(nextConfig);
