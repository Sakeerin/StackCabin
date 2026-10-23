import { spawnSync } from "node:child_process";
process.env.VITE_STACKCABIN_E2E = "1";
const result = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-b"],
  { stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status || 1);
const { build } = await import("vite");
await build();
await import("./third-party-notices.mjs");
