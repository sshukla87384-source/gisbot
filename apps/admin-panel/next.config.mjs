/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // The repo has no eslint config at all, so `next build` would stop to offer
  // to create one — keep this until one is added.
  eslint: { ignoreDuringBuilds: true },
  // The workspace typechecks clean, so a type error must fail the build rather
  // than ship. This was how a broken page reached production as a runtime crash.
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
