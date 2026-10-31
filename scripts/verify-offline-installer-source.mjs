import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { root, sha256, verifyCatalog } from "./catalog-lib.mjs";
import { catalogFiles } from "./windows-offline-manifest.mjs";

export function verifyInstallerRun(run, repository, runId) {
  if (!/^\d+$/.test(runId) || String(run.id) !== runId)
    throw new Error("Installer run ID does not match the requested run");
  if (run.status !== "completed" || run.conclusion !== "success")
    throw new Error("A successfully completed installer run is required");
  if (
    run.path !== ".github/workflows/preview-installers.yml" ||
    run.event !== "workflow_dispatch"
  )
    throw new Error("Expected the normal development installer workflow");
  for (const identity of [
    run.repository?.full_name,
    run.head_repository?.full_name,
  ])
    if (
      typeof identity !== "string" ||
      identity.toLowerCase() !== repository.toLowerCase()
    )
      throw new Error("Installer must come from this repository, not a fork");
  if (!/^[a-f0-9]{40}$/.test(run.head_sha))
    throw new Error("Invalid installer source commit");
  return run.head_sha;
}

// Reusing an app binary is safe only when differences are confined to these
// packaging, test and documentation inputs. Any other change needs a fresh build.
export function verifyPackagingChanges(files) {
  const packagingScripts = new Set([
    "scripts/Install-StackCabin.ps1",
    "scripts/windows-offline-bundle.ps1",
    "scripts/windows-offline-manifest.mjs",
    "scripts/verify-offline-installer-source.mjs",
    "scripts/offline-pack.mjs",
  ]);
  for (const file of files) {
    if (
      file === "README.md" ||
      file.startsWith("docs/") ||
      file.startsWith(".github/") ||
      /^scripts\/test[-_][^/]+$/.test(file) ||
      packagingScripts.has(file)
    )
      continue;
    throw new Error(
      `Application inputs changed since this installer was built: ${file}. Build a new normal installer first.`,
    );
  }
}

export function compareCatalogFiles(original, current) {
  const hashes = {};
  for (const file of [
    ...catalogFiles.map((file) => `runtime-catalog/${file}`),
    "runtime-catalog/windows-prerequisites.json",
  ]) {
    if (
      !Buffer.isBuffer(original[file]) ||
      !Buffer.isBuffer(current[file]) ||
      !original[file].equals(current[file])
    )
      throw new Error(`Installer catalog/prerequisite mismatch: ${file}`);
    hashes[file] = sha256(current[file]);
  }
  return hashes;
}

export async function inspectInstallerSource(run, repository, runId) {
  const source = verifyInstallerRun(run, repository, runId);
  const git = (...args) => execFileSync("git", ["-C", root, ...args]);
  const assemblyCommit = git("rev-parse", "HEAD").toString("utf8").trim();
  const changedFiles = git(
    "diff",
    "--no-renames",
    "--name-only",
    "-z",
    source,
    assemblyCommit,
    "--",
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  verifyPackagingChanges(changedFiles);
  const original = {};
  const current = {};
  for (const file of [
    ...catalogFiles.map((file) => `runtime-catalog/${file}`),
    "runtime-catalog/windows-prerequisites.json",
  ]) {
    original[file] = git("show", `${source}:${file}`);
    current[file] = await readFile(path.join(root, file));
  }
  const catalogHashes = compareCatalogFiles(original, current);
  await verifyCatalog();
  return {
    schemaVersion: 1,
    installerRun: runId,
    installerRunUrl: `https://github.com/${repository}/actions/runs/${runId}`,
    installerSourceCommit: source,
    assemblyCommit,
    catalogHashes,
    changedPackagingFiles: changedFiles,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [metadata, repository, runId] = process.argv.slice(2);
  if (!metadata || !/^[\w.-]+\/[\w.-]+$/.test(repository || ""))
    throw new Error(
      "Usage: node scripts/verify-offline-installer-source.mjs <run.json> <owner/repo> <run-id>",
    );
  const run = JSON.parse(
    (await readFile(metadata, "utf8")).replace(/^\uFEFF/, ""),
  );
  console.log(
    JSON.stringify(
      await inspectInstallerSource(run, repository, runId),
      null,
      2,
    ),
  );
}
