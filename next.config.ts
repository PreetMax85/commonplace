import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // next dev writes an AGENTS.md file for coding assistants on every run. This
  // project does not use it, and it reappears as an uncommitted change.
  agentRules: false,

  // The browser needs the project URL to start an anonymous session. The server
  // already has it, so it is passed through rather than set a second time.
  env: { NEXT_PUBLIC_SUPABASE_URL: process.env.SUPABASE_URL },

  // Transformers.js loads onnxruntime-node, which is a native addon the bundler
  // cannot process, so it is required at runtime instead.
  serverExternalPackages: ["@huggingface/transformers"],

  // That alone is not enough to deploy. Build tracing follows require() calls,
  // and onnxruntime_binding.node pulls in libonnxruntime.so through dlopen at
  // load time, which tracing cannot see. Without the shared library beside it
  // the addon fails to open and every route that embeds text returns a 500 on
  // its first request, so the shared library is listed by hand.
  // Only the two native files the CPU build needs are listed. The package ships
  // builds for other platforms, and on Linux it can also fetch GPU libraries of
  // about 270 MB, none of which can load on the deploy.
  // Transformers.js loads onnxruntime-node through createRequire, which tracing
  // does not follow either, so its JavaScript and the CommonJS build of
  // onnxruntime-common it requires are listed too.
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./node_modules/onnxruntime-node/package.json",
      "./node_modules/onnxruntime-node/dist/**",
      "./node_modules/onnxruntime-common/package.json",
      "./node_modules/onnxruntime-common/dist/cjs/**",
      "./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node",
      "./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1",
    ],
  },
};

export default nextConfig;
