import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  sha256,
  runtimeDownloadUrl,
  verifyCatalog,
} from "../../scripts/catalog-lib.mjs";
import {
  downloadRuntimeArchive,
  runtimeArchiveLimit,
} from "./runtime-archive-download.mjs";

export const catalogFiles = [
  "catalog.json",
  "catalog.sig",
  "public-key.txt",
  "provenance.json",
];
export const runtimeReceiptFile = "RUNTIME_PACK_RECEIPT.json";
const inside = (directory, file) => {
  const relative = path.relative(directory, file);
  return (
    !relative ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
};
// Windows path stats can report device zero while handle stats report the volume.
// BigInt inode values retain the complete file identity on all platforms.
const same = (a, b) =>
  a.ino === b.ino &&
  (a.dev === b.dev ||
    (process.platform === "win32" && (a.dev === 0n || b.dev === 0n)));
async function exists(file) {
  try {
    return await lstat(file, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function realDirectory(directory, optional = false) {
  directory = path.resolve(directory);
  for (let current = directory; ; current = path.dirname(current)) {
    const info = await exists(current);
    if (!info && optional && current === directory) return null;
    if (!info?.isDirectory() || info.isSymbolicLink())
      throw new Error(
        "Pack directories must be real directories without links",
      );
    if (path.dirname(current) === current) break;
  }
  return realpath(directory);
}

async function regular(file) {
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error("Expected a regular pack input without links");
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      !same(before, opened) ||
      before.size !== opened.size
    )
      throw new Error("Pack input changed while opening");
    return { handle, info: opened };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function control(file) {
  const { handle, info } = await regular(file);
  try {
    if (info.size <= 0 || info.size > 4 * 1024 * 1024)
      throw new Error("Expected a bounded nonempty pack control file");
    const size = Number(info.size);
    const chunks = [];
    let length = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      length += chunk.length;
      if (length > size) throw new Error("Pack control grew while reading");
      chunks.push(chunk);
    }
    if (length !== size)
      throw new Error("Pack control was truncated while reading");
    return Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}

async function ownedDirectory(directory, temporary = false) {
  const actual = temporary
    ? await mkdtemp(directory)
    : (await mkdir(directory, { mode: 0o755 }), directory);
  return {
    directory: actual,
    info: await lstat(actual, { bigint: true }),
    files: new Map(),
    fileMode: temporary ? 0o600 : 0o644,
  };
}

async function writeOwned(owner, name, source, expected, signal) {
  signal?.throwIfAborted();
  if (path.basename(name) !== name || !name || name === "." || name === "..")
    throw new Error("Invalid pack output name");
  const file = path.join(owner.directory, name),
    handle = await open(file, "wx", owner.fileMode);
  owner.files.set(name, await handle.stat({ bigint: true }));
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of source) {
      signal?.throwIfAborted();
      bytes += chunk.length;
      if (bytes > (expected?.bytes || runtimeArchiveLimit))
        throw new Error(`Pack file exceeds expected size: ${name}`);
      hash.update(chunk);
      await handle.writeFile(chunk);
    }
    const digest = hash.digest("hex");
    if (!bytes || (expected?.bytes && expected.bytes !== bytes))
      throw new Error(`Pack file size mismatch: ${name}`);
    if (expected?.sha256 && digest !== expected.sha256)
      throw new Error(`Runtime checksum mismatch: ${name}`);
    await handle.sync();
    return { file: name, bytes, sha256: digest };
  } finally {
    await handle.close();
  }
}

async function copyOwned(owner, name, source, expected, signal) {
  const { handle } = await regular(source);
  try {
    return await writeOwned(
      owner,
      name,
      handle.createReadStream({ autoClose: false }),
      expected,
      signal,
    );
  } finally {
    await handle.close();
  }
}

// Flat, identity-checked cleanup removes only files created by this operation.
// Unexpected or replaced files/directories are preserved, including late owners.
async function cleanup(owner) {
  if (!owner) return;
  const info = await exists(owner.directory);
  if (!info?.isDirectory() || info.isSymbolicLink() || !same(info, owner.info))
    return;
  if (
    path.dirname(await realpath(owner.directory)) !==
    path.dirname(path.resolve(owner.directory))
  )
    return;
  for (const [name, identity] of owner.files) {
    const file = path.join(owner.directory, name),
      actual = await exists(file);
    if (actual?.isFile() && !actual.isSymbolicLink() && same(actual, identity))
      await unlink(file).catch(() => {});
  }
  const final = await exists(owner.directory);
  if (
    final?.isDirectory() &&
    !final.isSymbolicLink() &&
    same(final, owner.info)
  )
    await rmdir(owner.directory).catch(() => {});
}

export async function buildOfflinePack({
  catalogDirectory,
  output,
  cache,
  platform,
  arch = "x64",
  development = false,
  offline = false,
  signal,
  onProgress = () => {},
  download = downloadRuntimeArchive,
}) {
  if (
    !["windows/x64", "linux/x64", "macos/x64", "macos/arm64"].includes(
      `${platform}/${arch}`,
    )
  )
    throw new Error("Unsupported offline pack target");
  const parent = await realDirectory(path.dirname(path.resolve(output)));
  output = path.join(parent, path.basename(path.resolve(output)));
  if (await exists(output))
    throw new Error(
      "Offline pack output already exists; choose a new directory",
    );
  catalogDirectory = await realDirectory(catalogDirectory);
  cache = path.resolve(cache);
  if (
    [catalogDirectory, cache].some(
      (input) => inside(input, output) || inside(output, input),
    )
  )
    throw new Error("Offline pack output overlaps an input directory");
  const cacheRoot = await realDirectory(cache, true);
  const captured = new Map();
  for (const name of catalogFiles)
    captured.set(name, await control(path.join(catalogDirectory, name)));
  let staging,
    destination,
    complete = false;
  const operation = AbortSignal.any([
    AbortSignal.timeout(30 * 60 * 1000),
    ...(signal ? [signal] : []),
  ]);
  try {
    operation.throwIfAborted();
    staging = await ownedDirectory(
      path.join(parent, ".stackcabin-offline-"),
      true,
    );
    const prepared = [];
    for (const [name, bytes] of captured)
      prepared.push(
        await writeOwned(
          staging,
          name,
          [bytes],
          { bytes: bytes.length, sha256: sha256(bytes) },
          operation,
        ),
      );
    const catalog = await verifyCatalog(staging.directory, !development);
    const artifacts = catalog.artifacts.filter(
      (item) => item.platform === platform && item.arch === arch,
    );
    if (!artifacts.length)
      throw new Error("No runtimes in the selected offline pack target");
    const archives = new Map();
    for (const item of artifacts) {
      if (
        !Number.isSafeInteger(item.size) ||
        item.size < 0 ||
        item.size > runtimeArchiveLimit
      )
        throw new Error("Invalid runtime archive size");
      const previous = archives.get(item.sha256);
      if (previous?.size && item.size && previous.size !== item.size)
        throw new Error("Conflicting sizes for the same runtime archive");
      if (!previous || item.size) archives.set(item.sha256, item);
    }
    for (const [digest, item] of archives) {
      operation.throwIfAborted();
      await onProgress({ phase: "archive", artifactId: item.id });
      let cached;
      if (cacheRoot)
        for (const name of new Set([digest, sha256(item.url)])) {
          const file = path.join(cacheRoot, name);
          if (await exists(file)) {
            cached = file;
            break;
          }
        }
      const expected = { bytes: item.size, sha256: digest };
      if (cached)
        prepared.push(
          await copyOwned(staging, digest, cached, expected, operation),
        );
      else {
        if (offline)
          throw new Error(`Offline cache is missing runtime: ${item.id}`);
        const bytes = await download(runtimeDownloadUrl(item), {
          signal: operation,
          expectedBytes: item.size,
        });
        prepared.push(
          await writeOwned(
            staging,
            digest,
            Buffer.isBuffer(bytes) ? [bytes] : bytes,
            expected,
            operation,
          ),
        );
      }
    }
    // Recheck the selected source before publishing a pack for that exact catalog.
    for (const [name, bytes] of captured)
      if (!bytes.equals(await control(path.join(catalogDirectory, name))))
        throw new Error("Trusted catalog changed during offline pack assembly");
    operation.throwIfAborted();
    await onProgress({ phase: "publishing", output });
    operation.throwIfAborted();
    destination = await ownedDirectory(output);
    const files = [];
    for (const entry of prepared)
      files.push(
        await copyOwned(
          destination,
          entry.file,
          path.join(staging.directory, entry.file),
          entry,
          operation,
        ),
      );
    const readme = Buffer.from(
      "StackCabin offline runtime pack\nChoose this folder in Runtimes > Install from offline pack.\nKeep the signed catalog and all archives together. Completion marker: RUNTIME_PACK_RECEIPT.json.\nFramework dependencies are not included.\n" +
        (development
          ? "DEVELOPMENT BUILD: clean-machine certification remains pending.\n"
          : ""),
    );
    await writeOwned(
      destination,
      "README.txt",
      [readme],
      { bytes: readme.length, sha256: sha256(readme) },
      operation,
    );
    const receipt = {
      schemaVersion: 1,
      scope: "signed-catalog-and-runtime-archives",
      completion: "complete",
      platform,
      arch,
      developmentMode: development,
      createdAt: new Date().toISOString(),
      artifactCount: artifacts.length,
      archiveCount: archives.size,
      artifacts: artifacts.map(({ id, sha256 }) => ({ id, sha256 })),
      files,
      productionApproved: false,
    };
    const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + "\n");
    await writeOwned(
      destination,
      runtimeReceiptFile,
      [bytes],
      { bytes: bytes.length, sha256: sha256(bytes) },
      operation,
    );
    complete = true;
    return { output, receipt };
  } finally {
    if (!complete) await cleanup(destination);
    await cleanup(staging);
  }
}

export async function verifyRuntimeReceipt(
  directory,
  { platform, arch, artifacts, files },
) {
  const file = path.join(directory, runtimeReceiptFile);
  if (!(await exists(file))) return { legacy: true };
  const receipt = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(await control(file)),
  );
  const ordered = (entries) =>
    [...entries].sort((a, b) => a.file.localeCompare(b.file));
  if (
    receipt.schemaVersion !== 1 ||
    receipt.scope !== "signed-catalog-and-runtime-archives" ||
    receipt.completion !== "complete" ||
    receipt.platform !== platform ||
    receipt.arch !== arch ||
    typeof receipt.developmentMode !== "boolean" ||
    receipt.productionApproved !== false ||
    typeof receipt.createdAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.createdAt)) ||
    receipt.artifactCount !== artifacts.length ||
    receipt.archiveCount !==
      new Set(artifacts.map((item) => item.sha256)).size ||
    !isDeepStrictEqual(
      receipt.artifacts,
      artifacts.map(({ id, sha256 }) => ({ id, sha256 })),
    ) ||
    !Array.isArray(receipt.files) ||
    !isDeepStrictEqual(ordered(receipt.files), ordered(files))
  )
    throw new Error(
      "Runtime pack completion receipt does not match verified catalog/archive bytes",
    );
  return { legacy: false };
}
