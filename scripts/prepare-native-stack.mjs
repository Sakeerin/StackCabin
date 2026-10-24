// Changes only an ephemeral CI checkout; the shipping catalog remains unchanged.
import { readFile, mkdir, copyFile, appendFile } from "node:fs/promises";
import path from "node:path";
import {
  root,
  verifyCatalog,
  saveCatalog,
  signingKey,
} from "./catalog-lib.mjs";
import { verifyNativeStack } from "./native-stack-lib.mjs";

if (process.env.GITHUB_ACTIONS !== "true" || !process.env.GITHUB_ENV)
  throw new Error("This helper requires an ephemeral GitHub Actions checkout");
const platform = process.platform === "darwin" ? "macos" : "linux";
const arch = process.env.STACKCABIN_TEST_ARCH || process.arch;
const selections = JSON.parse(
  await readFile(
    path.join(root, "runtime-catalog/native-test-builds.json"),
    "utf8",
  ),
);
const builds = selections.targets[`${platform}-${arch}`];
if (!builds || builds.length !== 4)
  throw new Error("No complete reviewed native stack for this target");
const { sources } = JSON.parse(
  await readFile(
    path.join(root, "runtime-catalog/source-archives.json"),
    "utf8",
  ),
);
const folder = path.join(root, "artifacts/runtimes");
const native = await verifyNativeStack(folder, platform, arch, builds, sources);
const { artifacts } = await verifyCatalog();
const merged = new Map(artifacts.map((a) => [a.id, a]));
for (const artifact of native) {
  const existing = merged.get(artifact.id);
  if (existing && existing.sha256 !== artifact.sha256)
    throw new Error(`Immutable runtime collision: ${artifact.id}`);
  merged.set(artifact.id, artifact);
}
await saveCatalog([...merged.values()], await signingKey(true), true);
const offline = path.join(root, `artifacts/offline-${platform}-${arch}`);
await mkdir(offline, { recursive: true });
for (const artifact of native)
  await copyFile(
    path.join(folder, artifact.id + ".tar.gz"),
    path.join(offline, artifact.sha256),
  );
await appendFile(
  process.env.GITHUB_ENV,
  Object.entries({
    STACKCABIN_SMOKE_DIR: path.join(root, ".local/combined stack ทดสอบ"),
    STACKCABIN_OFFLINE_DIR: offline,
    STACKCABIN_SMOKE_COMPONENTS:
      "node,caddy,php,cacert,composer,pnpm,yarn,mariadb,postgres",
    STACKCABIN_SMOKE_BRANCHES: "22.,24.,8.4.,8.5.",
  })
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n",
);
console.log(
  "Prepared full native stack for INTERNAL TESTING ONLY; no catalog is published.",
);
