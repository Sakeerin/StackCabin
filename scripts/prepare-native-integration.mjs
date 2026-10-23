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
import { root, sha256 } from "./catalog-lib.mjs";
if (!process.env.GITHUB_ENV)
  throw new Error(
    "This helper runs only in an ephemeral GitHub Actions checkout",
  );
const platform = process.platform === "darwin" ? "macos" : "linux";
const arch =
  process.env.STACKCABIN_TEST_ARCH ||
  (process.arch === "arm64" ? "arm64" : "x64");
if (!["arm64", "x64"].includes(arch))
  throw new Error("Unsupported test architecture");
const component = process.env.COMPONENT;
const version = process.env.VERSION;
if (
  !["php", "mariadb", "postgres"].includes(component) ||
  !/^\d+\.\d+(?:\.\d+)?$/.test(version || "")
)
  throw new Error("Pass an exact native component/version");
const identifier = [component, version, platform, arch].join("-");
const folder = path.join(root, "artifacts", "runtimes");
let artifact;
try {
  artifact = JSON.parse(
    await readFile(path.join(folder, identifier + ".json"), "utf8"),
  );
} catch (error) {
  if (
    error.code !== "ENOENT" ||
    process.env.STACKCABIN_TEST_FAILED_CANDIDATE !== "true"
  )
    throw error;
  const source = JSON.parse(
    await readFile(
      path.join(root, "runtime-catalog/source-archives.json"),
      "utf8",
    ),
  ).sources.find(
    (source) => source.component === component && source.version === version,
  );
  if (!source)
    throw new Error("Candidate version is not a reviewed publisher source");
  const bytes = await readFile(path.join(folder, identifier + ".tar.gz"));
  const tools =
    component === "php"
      ? { php: "bin/php", "php-fpm": "sbin/php-fpm" }
      : component === "postgres"
        ? Object.fromEntries(
            ["postgres", "initdb", "psql", "pg_dump", "pg_ctl"].map((tool) => [
              tool,
              "bin/" + tool,
            ]),
          )
        : {
            mariadbd: "bin/mariadbd",
            mariadb: "bin/mariadb",
            "mariadb-dump": "bin/mariadb-dump",
            "install-db": "scripts/mariadb-install-db",
          };
  artifact = {
    id: identifier,
    component,
    version,
    platform,
    arch,
    archive: "tar.gz",
    stripComponents: 1,
    sha256: sha256(bytes),
    size: bytes.length,
    executables: tools,
    sourceUrl: source.sourceUrl,
    url:
      "https://example.invalid/test-only-candidate/" + identifier + ".tar.gz",
    license:
      component === "mariadb"
        ? "GPL-2.0-only"
        : component === "php"
          ? "PHP-3.01"
          : "PostgreSQL",
  };
  console.log(
    "TEST ONLY: verifying an unapproved failed-build candidate; no release metadata is created.",
  );
}
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
const smoke = path.join(root, ".local", "native-integration ทดสอบ");
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
