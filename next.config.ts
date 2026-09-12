import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Transformers.js loads onnxruntime-node, whose native binary cannot be
  // bundled. Leaving it external lets the server require it at runtime.
  serverExternalPackages: ["@xenova/transformers"],
};

export default nextConfig;
