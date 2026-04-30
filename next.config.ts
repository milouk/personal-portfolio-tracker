import type { NextConfig } from "next";

const isDemo = process.env.DEMO === "1";
// When deployed to GitHub Pages under https://<user>.github.io/<repo>/, asset
// paths must be prefixed. Set BASE_PATH=/personal-portfolio-tracker (or
// whatever the repo name is) at build time.
const basePath = process.env.BASE_PATH ?? "";

const nextConfig: NextConfig = {
  ...(isDemo && {
    output: "export",
    images: { unoptimized: true },
    basePath,
    assetPrefix: basePath,
    trailingSlash: true,
  }),
  env: {
    NEXT_PUBLIC_DEMO: isDemo ? "1" : "0",
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

export default nextConfig;
