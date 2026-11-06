// Read-only packaging admission. Independent receipt/key pins bind the four
// signing outputs; this does not authorize publication or certify source/VMs.
import { createHash, createPublicKey, verify } from "node:crypto";
import { lstat, open, readdir, realpath, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mergeCatalog } from "./prepare-catalog-proposal.mjs";
import { releaseBase } from "../../scripts/prepare-native-release.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const validHash = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const parse = (bytes) =>
  JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
const signedFiles = [
  "catalog.json",
  "catalog.sig",
  "public-key.txt",
  "provenance.json",
];
const resources = [
  "php-macos-library-sources.json",
  "source-archives.json",
  "windows-prerequisites.json",
];
const developmentKeyHash =
  "203a1d0ff09c35d787e568a4cc4e746437454cf075a179960cfbb378597820d0";
const inside = (directory, file) => {
  const relative = path.relative(directory, file);
  return (
    !relative ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
};

async function readControl(file) {
  const entry = await lstat(file);
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.size <= 0 ||
    entry.size > 4 * 1024 * 1024
  )
    throw new Error("Expected a nonempty bounded regular catalog control file");
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.ino !== entry.ino ||
      opened.size !== entry.size
    )
      throw new Error("Catalog control changed while opening");
    let length = 0;
    const chunks = [];
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      length += chunk.length;
      if (length > entry.size)
        throw new Error("Catalog control grew while reading");
      chunks.push(chunk);
    }
    if (length !== entry.size)
      throw new Error("Catalog control was truncated while reading");
    const bytes = Buffer.concat(chunks);
    return { bytes, size: length, sha256: hash(bytes) };
  } finally {
    await handle.close();
  }
}

export async function verifyReleaseCatalog({
  directory,
  receipt,
  receiptSha256,
  publicKeySha256,
  repository,
}) {
  if (!validHash(receiptSha256) || !validHash(publicKeySha256))
    throw new Error(
      "Separately retained signing-receipt and production public-key file hashes are required",
    );
  if (publicKeySha256 === developmentKeyHash)
    throw new Error(
      "Release blocked: the known development signing identity is forbidden",
    );
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Catalog must be a real directory");
  directory = await realpath(directory);
  const receiptPath = await realpath(path.dirname(path.resolve(receipt)));
  receipt = path.join(receiptPath, path.basename(path.resolve(receipt)));
  if (inside(directory, receipt))
    throw new Error(
      "Retain the signing receipt outside shipping catalog resources",
    );
  const held = await readControl(receipt);
  if (held.sha256 !== receiptSha256)
    throw new Error("Retained signing-receipt hash mismatch");
  const record = parse(held.bytes);
  if (
    record.schemaVersion !== 1 ||
    record.scope !== "catalog-signature-only" ||
    record.catalogSigned !== true ||
    record.productionApproved !== false ||
    record.repository !== repository ||
    record.publicKeySha256 !== publicKeySha256 ||
    !validHash(record.catalogSha256) ||
    !validHash(record.handoffSha256) ||
    !validHash(record.basePublicKeySha256) ||
    !validHash(record.manifestSha256) ||
    typeof record.signedAt !== "string" ||
    !Number.isFinite(Date.parse(record.signedAt))
  )
    throw new Error("Invalid signing-receipt identity or review pins");
  releaseBase(repository, record.tag);
  if (
    !Array.isArray(record.files) ||
    record.files.length !== signedFiles.length ||
    new Set(record.files.map((item) => item.name)).size !==
      signedFiles.length ||
    record.files.some(
      (item) =>
        !signedFiles.includes(item.name) ||
        !validHash(item.sha256) ||
        !Number.isSafeInteger(item.size) ||
        item.size <= 0,
    )
  )
    throw new Error("Invalid signing-receipt file inventory");
  const names = await readdir(directory);
  if (
    names.some((name) => ![...signedFiles, ...resources].includes(name)) ||
    signedFiles.some((name) => !names.includes(name))
  )
    throw new Error(
      "Shipping catalog has missing or unrecognized resources; keep signing evidence and keys outside it",
    );
  const files = new Map();
  for (const name of names)
    files.set(name, await readControl(path.join(directory, name)));
  for (const item of record.files) {
    const actual = files.get(item.name);
    if (actual.size !== item.size || actual.sha256 !== item.sha256)
      throw new Error(
        `Signed catalog file differs from the retained receipt: ${item.name}`,
      );
  }
  const keyFile = files.get("public-key.txt");
  if (
    keyFile.sha256 !== publicKeySha256 ||
    files.get("catalog.json").sha256 !== record.catalogSha256
  )
    throw new Error(
      "Catalog/public key differs from the independently selected signing receipt/key",
    );
  const raw = Buffer.from(keyFile.bytes.toString("utf8").trim(), "base64");
  const canonical = Buffer.from(raw.toString("base64") + "\n");
  if (raw.length !== 32 || hash(canonical) === developmentKeyHash)
    throw new Error(
      "Release blocked: invalid or known development Ed25519 signing identity",
    );
  if (!keyFile.bytes.equals(canonical))
    throw new Error("Use the canonical reviewed public-key.txt bytes");
  const sigFile = files.get("catalog.sig");
  const signature = Buffer.from(
    sigFile.bytes.toString("utf8").trim(),
    "base64",
  );
  if (
    signature.length !== 64 ||
    !sigFile.bytes.equals(Buffer.from(signature.toString("base64") + "\n"))
  )
    throw new Error("Invalid/noncanonical catalog signature encoding");
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
    type: "spki",
    format: "der",
  });
  if (!verify(null, files.get("catalog.json").bytes, key, signature))
    throw new Error("Invalid production catalog signature");
  const catalog = parse(files.get("catalog.json").bytes);
  if (
    catalog.schemaVersion !== 1 ||
    typeof catalog.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(catalog.generatedAt))
  )
    throw new Error("Invalid release catalog schema/timestamp");
  mergeCatalog(catalog, []); // Same artifact/path/minimum-OS/full-target contracts as proposal creation.
  if (record.artifactCount !== catalog.artifacts.length)
    throw new Error("Signing-receipt artifact count differs from catalog");
  const provenance = parse(files.get("provenance.json").bytes);
  for (const field of [
    "schemaVersion",
    "scope",
    "catalogSha256",
    "handoffSha256",
    "basePublicKeySha256",
    "publicKeySha256",
    "artifactCount",
    "repository",
    "tag",
    "manifestSha256",
    "productionApproved",
  ])
    if (provenance[field] !== record[field])
      throw new Error(
        `Catalog provenance differs from retained signing receipt: ${field}`,
      );
  if (
    provenance.developmentKey !== false ||
    provenance.generatedAt !== record.signedAt ||
    !validHash(provenance.sourceInventorySha256) ||
    !isDeepStrictEqual(
      provenance.artifacts,
      catalog.artifacts.map(({ id, url, sourceUrl, sha256 }) => ({
        id,
        url,
        sourceUrl,
        sha256,
      })),
    )
  )
    throw new Error("Invalid production provenance or artifact inventory");
  return {
    schemaVersion: 1,
    verification: "release-catalog-integrity-passed",
    scope: "signed-catalog-and-review-pins",
    repository,
    tag: record.tag,
    receiptSha256,
    publicKeySha256,
    catalogSha256: record.catalogSha256,
    handoffSha256: record.handoffSha256,
    manifestSha256: record.manifestSha256,
    artifactCount: catalog.artifacts.length,
    files: [...files]
      .map(([name, { size, sha256 }]) => ({ name, size, sha256 }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    privateKeyAccessed: false,
    productionApproved: false,
  };
}

export async function main(arguments_) {
  const args = {};
  for (const argument of arguments_) {
    const match =
      /^--(directory|receipt|receipt-sha256|public-key-sha256|repository|report)=(.+)$/.exec(
        argument,
      );
    if (!match || Object.hasOwn(args, match[1]))
      throw new Error("Unknown or duplicate release catalog argument");
    args[match[1]] = match[2];
  }
  for (const name of [
    "directory",
    "receipt",
    "receipt-sha256",
    "public-key-sha256",
    "repository",
  ])
    if (!args[name]) throw new Error(`Missing required --${name}`);
  const result = await verifyReleaseCatalog({
    ...args,
    receiptSha256: args["receipt-sha256"],
    publicKeySha256: args["public-key-sha256"],
  });
  if (args.report) {
    const parent = await realpath(path.dirname(path.resolve(args.report)));
    const report = path.join(parent, path.basename(path.resolve(args.report)));
    if (
      inside(await realpath(args.directory), report) ||
      report === (await realpath(args.receipt))
    )
      throw new Error(
        "Verification report must stay outside catalog resources and the retained receipt",
      );
    await writeFile(report, JSON.stringify(result, null, 2) + "\n", {
      flag: "wx",
    });
  }
  console.log(JSON.stringify(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
