import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { root, verifyCatalog } from "./catalog-lib.mjs";

export const catalogFiles = [
  "catalog.json",
  "catalog.sig",
  "public-key.txt",
  "provenance.json",
];
export const bundleFiles = [
  ...catalogFiles,
  "StackCabin-setup.exe",
  "Install-StackCabin.ps1",
  "Install.cmd",
  "README.txt",
  "LICENSE",
  "THIRD_PARTY_NOTICES.txt",
  "windows-prerequisites.json",
  "prerequisites/install-vc-runtime.ps1",
  "prerequisites/vc_redist.x64.exe",
  "prerequisites/MicrosoftEdgeWebView2RuntimeInstallerX64.exe",
];

async function fileInfo(directory, relative) {
  let file = directory;
  for (const part of relative.split("/")) {
    file = path.join(file, part);
    if ((await lstat(file)).isSymbolicLink())
      throw new Error(`Bundle links are not supported: ${relative}`);
  }
  const info = await lstat(file);
  if (!info.isFile()) throw new Error(`Expected a bundle file: ${relative}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { file: relative, bytes: info.size, sha256: hash.digest("hex") };
}

// The builder trusts the checkout's catalog, never a key supplied only by the pack.
export async function verifyRuntimePack(
  directory,
  trustedCatalog = path.join(root, "runtime-catalog"),
) {
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error("Bundle directory must not be a link");
  const catalog = await verifyCatalog(trustedCatalog);
  for (const file of catalogFiles) {
    const actual = await fileInfo(directory, file);
    const expected = await fileInfo(trustedCatalog, file);
    if (actual.sha256 !== expected.sha256)
      throw new Error(
        `Offline pack does not match the application's catalog: ${file}`,
      );
  }
  const artifacts = catalog.artifacts.filter(
    (a) => a.platform === "windows" && a.arch === "x64",
  );
  if (!artifacts.length) throw new Error("No Windows x64 runtimes in catalog");
  const archives = [];
  for (const digest of new Set(artifacts.map((a) => a.sha256))) {
    const entry = await fileInfo(directory, digest);
    if (entry.sha256 !== digest)
      throw new Error(`Runtime checksum mismatch: ${digest}`);
    archives.push(entry);
  }
  return { runtimeCount: artifacts.length, archives };
}

export async function writeBundleManifest(directory) {
  const { runtimeCount, archives } = await verifyRuntimePack(directory);
  const files = [];
  for (const file of bundleFiles) files.push(await fileInfo(directory, file));
  const { version } = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  const manifest = {
    schemaVersion: 1,
    platform: "windows",
    arch: "x64",
    appVersion: version,
    createdAt: new Date().toISOString(),
    files: [...files, ...archives],
  };
  const temporary = path.join(
    directory,
    `installer-manifest.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n", {
      flag: "wx",
    });
    await rename(temporary, path.join(directory, "installer-manifest.json"));
  } finally {
    await rm(temporary, { force: true });
  }
  return { runtimeCount, fileCount: manifest.files.length };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [mode, directory] = process.argv.slice(2);
  if (!["--verify", "--write"].includes(mode) || !directory)
    throw new Error(
      "Usage: node scripts/windows-offline-manifest.mjs --verify|--write <bundle>",
    );
  const result =
    mode === "--write"
      ? await writeBundleManifest(path.resolve(directory))
      : await verifyRuntimePack(path.resolve(directory));
  console.log(
    JSON.stringify({
      runtimeCount: result.runtimeCount,
      fileCount: result.fileCount,
    }),
  );
}
