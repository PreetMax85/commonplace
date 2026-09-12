import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Transformers.js loads onnxruntime-node, which is a native addon the bundler
  // cannot process, so it is required at runtime instead.
  serverExternalPackages: ["@xenova/transformers"],

  // That alone is not enough to deploy. Build tracing follows require() calls,
  // and onnxruntime_binding.node pulls in libonnxruntime.so through dlopen at
  // load time, which tracing cannot see. Without the shared library beside it
  // the addon fails to open and every route that embeds text returns a 500 on
  // its first request. Ship the whole native directory.
  // Scoped to the platform the deploy actually runs on. The package ships seven
  // platform builds and tracing all of them adds about 100 MB of binaries that
  // can never load there.
  outputFileTracingIncludes: {
    "/api/**/*": ["./node_modules/onnxruntime-node/bin/napi-v3/linux/x64/**"],
  },
};

export default nextConfig;
