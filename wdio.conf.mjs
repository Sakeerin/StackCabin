import path from "node:path";
import { mkdir } from "node:fs/promises";
const dataDirectory = path.resolve(".local/e2e", String(Date.now()));
await mkdir(path.join(dataDirectory, "projects"), { recursive: true });
await mkdir(path.resolve("artifacts"), { recursive: true });
process.env.STACKCABIN_DATA_DIR = path.join(dataDirectory, "app-data");
process.env.STACKCABIN_E2E_PROJECTS = path.join(dataDirectory, "projects");
const appBinaryPath =
  process.env.STACKCABIN_E2E_BINARY ||
  path.resolve(
    `target/debug/stackcabin${process.platform === "win32" ? ".exe" : ""}`,
  );
export const config = {
  runner: "local",
  specs: ["./e2e/desktop.e2e.mjs"],
  maxInstances: 1,
  capabilities: [
    { browserName: "tauri", "tauri:options": { application: appBinaryPath } },
  ],
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath,
        driverProvider: "embedded",
        startTimeout: 60000,
        commandTimeout: 30000,
      },
    ],
  ],
  logLevel: "warn",
  framework: "mocha",
  reporters: ["spec"],
  waitforTimeout: 15000,
  mochaOpts: { timeout: process.env.STACKCABIN_E2E_OFFLINE ? 300000 : 60000 },
};
