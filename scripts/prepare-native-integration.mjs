// Test-only catalog generation in an ephemeral CI checkout; never publishes a catalog.
import {
  readFile,
  writeFile,
  mkdir,
  copyFile,
  appendFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { root } from "./catalog-lib.mjs";
if (!process.env.GITHUB_ENV)
  throw new Error(
    "This helper runs only in an ephemeral GitHub Actions checkout",
  );
const platform = process.platform === "darwin" ? "macos" : "linux";
const arch = process.arch === "arm64" ? "arm64" : "x64";
const component = process.env.COMPONENT;
const version = process.env.VERSION;
if (
  !["php", "mariadb", "postgres"].includes(component) ||
  !/^\d+\.\d+(?:\.\d+)?$/.test(version || "")
)
  throw new Error("Pass an exact native component/version");
const identifier = [component, version, platform, arch].join("-");
const folder = path.join(root, "artifacts", "runtimes");
const artifact = JSON.parse(
  await readFile(path.join(folder, identifier + ".json"), "utf8"),
);
if (artifact.id !== identifier)
  throw new Error("Native artifact identity mismatch");
const extra = path.join(root, ".local", "native-test-catalog.json");
await mkdir(path.dirname(extra), { recursive: true });
await writeFile(extra, JSON.stringify([artifact]));
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "scripts", "build-catalog.mjs"),
    "--dev",
    "--components=pnpm",
    "--extra=" + extra,
  ],
  { stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status || 1);
const smoke = path.join(root, ".local", "native-integration");
const cache = path.join(smoke, "app-data", "downloads");
await mkdir(cache, { recursive: true });
await copyFile(
  path.join(folder, identifier + ".tar.gz"),
  path.join(cache, artifact.sha256),
);
const settings = {
  STACKCABIN_SMOKE_DIR: smoke,
  STACKCABIN_SMOKE_COMPONENTS: component === "php" ? "php,caddy" : component,
  STACKCABIN_SMOKE_BRANCHES: version.split(".").slice(0, 2).join(".") + ".",
};
await appendFile(
  process.env.GITHUB_ENV,
  Object.entries(settings)
    .map(([key, value]) => key + "=" + value)
    .join("\n") + "\n",
);
console.log("Prepared signed native integration catalog for " + identifier);
