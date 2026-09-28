// Loads the embedding library from only the files the build packaged for each
// route, as a deployed function has to.
//
// Build tracing cannot see everything Transformers.js loads: it reaches ONNX
// Runtime through createRequire, and the native addon opens its shared library
// through dlopen. next.config.ts lists those files by hand, and a package that
// moves them breaks every route that embeds text on the deploy while the build
// and a local `next start` both succeed. This runs after `next build` so that
// failure stops the build instead.
//
// It imports the library without loading a model, which already requires ONNX
// Runtime's JavaScript and opens the native addon and its shared library.
import { spawnSync } from "node:child_process";
import {
  copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync,
  readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The deploy runs on Linux x64 and only that native build is traced.
if (process.platform !== "linux" || process.arch !== "x64") {
  console.log(`check-trace: skipped on ${process.platform}/${process.arch}, the deploy target is linux/x64`);
  process.exit(0);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, ".next", "server", "app");
if (!existsSync(appDir)) {
  console.error("check-trace: no build output in .next, run next build first");
  process.exit(1);
}

function* traceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* traceFiles(path);
    else if (entry.name.endsWith(".nft.json")) yield path;
  }
}

// Returns why the library could not load from these files, or null if it did.
function loadFrom(files) {
  const sandbox = mkdtempSync(join(tmpdir(), "check-trace-"));
  try {
    for (const file of files) {
      const rel = relative(root, file);
      if (!rel.startsWith("node_modules")) continue;
      if (!existsSync(file)) return `traced file is missing: ${rel}`;
      const target = join(sandbox, rel);
      mkdirSync(dirname(target), { recursive: true });
      // Hard links make this near instant; a temp directory on another
      // filesystem falls back to copying.
      try {
        linkSync(file, target);
      } catch {
        copyFileSync(file, target);
      }
    }
    writeFileSync(join(sandbox, "probe.mjs"), `await import("@huggingface/transformers");\n`);

    // Module resolution walks up parent directories and honours NODE_PATH, and
    // the dynamic loader honours LD_LIBRARY_PATH, so any of them could supply a
    // file the deploy will not have. The permission model keeps reads inside
    // the sandbox and the probe starts with an otherwise empty environment.
    const run = spawnSync(
      process.execPath,
      ["--permission", "--allow-addons", `--allow-fs-read=${sandbox}`, "probe.mjs"],
      { cwd: sandbox, env: { PATH: process.env.PATH }, encoding: "utf8" }
    );
    if (run.status === 0) return null;
    if (run.error) return run.error.message;
    if (run.signal) return `probe was killed by ${run.signal}`;
    const output = run.stderr || run.stdout;
    return output.split("\n").find((line) => /^\w*Error( \[\w+\])?: /.test(line)) ?? `exit ${run.status}`;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

let checked = 0;
let failed = 0;

for (const trace of traceFiles(appDir)) {
  const files = JSON.parse(readFileSync(trace, "utf8")).files.map((f) => resolve(dirname(trace), f));
  if (!files.some((f) => f.includes("/node_modules/@huggingface/transformers/"))) continue;

  const route = relative(appDir, trace).replace(/\.js\.nft\.json$/, "");
  const reason = loadFrom(files);
  checked++;
  if (reason === null) {
    console.log(`check-trace: ok      ${route}`);
  } else {
    failed++;
    console.error(`check-trace: FAILED  ${route}\n  ${reason.trim()}`);
  }
}

if (checked === 0) {
  console.error("check-trace: no route traced @huggingface/transformers, so nothing embeds text on the deploy");
  process.exit(1);
}
if (failed > 0) {
  console.error(`check-trace: ${failed} of ${checked} routes cannot load the embedding library from their traced files`);
  process.exit(1);
}
