// Produce a reviewable, unsigned catalog without opening any signing key.
// --hosted repeats the public byte checks; a saved JSON report is not a credential.
import { createHash, createPublicKey, verify } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  verifyCandidate,
  verifyHostedCandidate,
} from "./verify-native-release.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (bytes) =>
  JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
const encode = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const targets = ["windows-x64", "linux-x64", "macos-x64", "macos-arm64"];
const required = [
  "node",
  "php",
  "composer",
  "caddy",
  "mariadb",
  "postgres",
  "pnpm",
  "yarn",
];
const nativeTools = {
  php: ["php", "php-fpm"],
  mariadb: ["mariadbd", "mariadb", "mariadb-dump", "install-db"],
  postgres: ["postgres", "initdb", "psql", "pg_dump", "pg_ctl"],
};

async function control(directory, name, expected) {
  const file = path.join(directory, name);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024)
    throw new Error(`Expected a bounded regular control file: ${name}`);
  const bytes = await readFile(file);
  if (
    expected &&
    (bytes.length !== expected.size || digest(bytes) !== expected.sha256)
  )
    throw new Error(`Control bytes differ from verified candidate: ${name}`);
  return bytes;
}

async function realDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Input directory must be a real directory");
  return realpath(directory);
}

function inside(directory, file) {
  const relative = path.relative(directory, file);
  return (
    !relative ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function https(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && !url.username && !url.password && !url.hash
    );
  } catch {
    return false;
  }
}

function safeExecutable(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !/[\\:\x00-\x1f]/.test(value) &&
    value
      .split("/")
      .every(
        (part) =>
          part &&
          part !== "." &&
          part !== ".." &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  );
}

function validateArtifact(item, native = false) {
  if (
    !item ||
    typeof item !== "object" ||
    Array.isArray(item) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.id || "") ||
    item.id !==
      `${item.component}-${item.version}-${item.platform}-${item.arch}` ||
    !targets.includes(`${item.platform}-${item.arch}`) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.version || "") ||
    !/^[a-f0-9]{64}$/.test(item.sha256 || "") ||
    !https(item.url) ||
    !https(item.sourceUrl) ||
    !["zip", "tar.gz", "tar.xz", "file"].includes(item.archive) ||
    !Number.isSafeInteger(item.stripComponents) ||
    item.stripComponents < 0 ||
    item.stripComponents > 16 ||
    !Number.isSafeInteger(item.size) ||
    item.size < 0 ||
    (native && item.size === 0) ||
    typeof item.license !== "string" ||
    !item.license.trim() ||
    !item.executables ||
    typeof item.executables !== "object" ||
    Array.isArray(item.executables) ||
    !Object.keys(item.executables).length ||
    Object.entries(item.executables).some(
      ([tool, file]) =>
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tool) || !safeExecutable(file),
    )
  )
    throw new Error(`Invalid catalog artifact metadata: ${item?.id}`);
  if (
    native &&
    (!nativeTools[item.component] ||
      item.archive !== "tar.gz" ||
      item.stripComponents !== 1 ||
      nativeTools[item.component].some(
        (tool) => !Object.hasOwn(item.executables, tool),
      ))
  )
    throw new Error(`Missing native executable contract: ${item.id}`);
  if (item.platform === "macos" && nativeTools[item.component]) {
    if (!/^\d+\.\d+(?:\.\d+)?$/.test(item.minimumOsVersion || ""))
      throw new Error(`Missing minimum macOS version: ${item.id}`);
    const [major, minor, patch = 0] = item.minimumOsVersion
      .split(".")
      .map(Number);
    if (major > 14 || (major === 14 && (minor > 0 || patch > 0)))
      throw new Error(
        `Native artifact exceeds macOS 14.0 baseline: ${item.id}`,
      );
  }
}

export function mergeCatalog(base, additions) {
  if (
    base.schemaVersion !== 1 ||
    !Array.isArray(base.artifacts) ||
    !Array.isArray(additions)
  )
    throw new Error("Unsupported catalog schema");
  const merged = new Map();
  for (const item of base.artifacts) {
    validateArtifact(item);
    if (merged.has(item.id))
      throw new Error(`Duplicate base catalog ID: ${item.id}`);
    merged.set(item.id, item);
  }
  const added = [],
    retained = [];
  const seen = new Set();
  for (const item of additions) {
    validateArtifact(item, true);
    if (seen.has(item.id))
      throw new Error(`Duplicate native catalog ID: ${item.id}`);
    seen.add(item.id);
    if (merged.has(item.id)) {
      if (!isDeepStrictEqual(merged.get(item.id), item))
        throw new Error(
          `Immutable catalog ID has different metadata: ${item.id}`,
        );
      retained.push(item.id);
    } else {
      merged.set(item.id, item);
      added.push(item.id);
    }
  }
  const artifacts = [...merged.values()];
  for (const target of targets) {
    const items = artifacts.filter(
      (item) => `${item.platform}-${item.arch}` === target,
    );
    for (const component of required)
      if (!items.some((item) => item.component === component))
        throw new Error(`Incomplete catalog matrix: ${target}/${component}`);
    for (const [component, branches] of [
      ["node", ["22.", "24."]],
      ["php", ["8.4.", "8.5."]],
    ])
      for (const branch of branches)
        if (
          !items.some(
            (item) =>
              item.component === component && item.version.startsWith(branch),
          )
        )
          throw new Error(
            `Incomplete catalog matrix: ${target}/${component} ${branch}`,
          );
  }
  return { artifacts, added, retained };
}

export async function prepareCatalogProposal({
  directory,
  repository,
  tag,
  manifestSha256,
  catalogDirectory,
  publicKeySha256,
  output,
  hosted = false,
  transport = {},
}) {
  if (!/^[a-f0-9]{64}$/.test(publicKeySha256 || ""))
    throw new Error("A separately trusted public-key.txt SHA-256 is required");
  catalogDirectory = await realDirectory(catalogDirectory);
  const candidate = await verifyCandidate(directory, {
    repository,
    tag,
    manifestSha256,
  });
  const parent = await realpath(path.dirname(path.resolve(output)));
  output = path.join(parent, path.basename(path.resolve(output)));
  if (
    [candidate.directory, catalogDirectory].some(
      (input) => inside(input, output) || inside(output, input),
    )
  )
    throw new Error(
      "Proposal output must be separate from both input directories",
    );
  // Refuse existing destinations before doing a potentially expensive public check.
  try {
    await lstat(output);
    throw new Error("Proposal output already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const baseFiles = new Map();
  for (const name of ["catalog.json", "catalog.sig", "public-key.txt"])
    baseFiles.set(name, await control(catalogDirectory, name));
  if (digest(baseFiles.get("public-key.txt")) !== publicKeySha256)
    throw new Error(
      "Base catalog trust root does not match the retained public-key hash",
    );
  const raw = Buffer.from(
    baseFiles.get("public-key.txt").toString("utf8").trim(),
    "base64",
  );
  const signature = Buffer.from(
    baseFiles.get("catalog.sig").toString("utf8").trim(),
    "base64",
  );
  if (
    raw.length !== 32 ||
    signature.length !== 64 ||
    !verify(
      null,
      baseFiles.get("catalog.json"),
      createPublicKey({
        key: Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"),
          raw,
        ]),
        type: "spki",
        format: "der",
      }),
      signature,
    )
  )
    throw new Error("Invalid base catalog signature");
  const controls = new Map();
  for (const name of [
    "native-artifacts.json",
    "source-inventory.json",
    "release-manifest.json",
  ])
    controls.set(
      name,
      await control(
        candidate.directory,
        name,
        candidate.report.files.find((entry) => entry.name === name),
      ),
    );
  const base = json(baseFiles.get("catalog.json"));
  const merged = mergeCatalog(
    base,
    json(controls.get("native-artifacts.json")),
  );
  const verification = hosted
    ? await verifyHostedCandidate(candidate, transport)
    : candidate.report;
  const files = new Map([
    [
      "catalog.proposed.json",
      encode({
        schemaVersion: 1,
        generatedAt: verification.verifiedAt,
        artifacts: merged.artifacts,
      }),
    ],
    ["candidate-verification.json", encode(verification)],
    ...controls,
    ...[...baseFiles].map(([name, bytes]) => [`base-${name}`, bytes]),
  ]);
  const handoff = {
    schemaVersion: 1,
    status: hosted
      ? "hosted-bytes-verified-awaiting-release-review"
      : "review-only-awaiting-public-hosting",
    catalogSigned: false,
    productionApproved: false,
    repository,
    tag,
    manifestSha256,
    baseCatalogSha256: digest(baseFiles.get("catalog.json")),
    publicKeySha256,
    baseArtifacts: base.artifacts.length,
    nativeArtifacts: candidate.report.runtimeCount,
    proposedArtifacts: merged.artifacts.length,
    addedIds: merged.added,
    unchangedIds: merged.retained,
    hostedVerification: verification.hostedVerification,
    remainingGates: [
      ...(!hosted
        ? [
            "Publish immutable reviewed native assets and verify every public byte",
          ]
        : []),
      "Review source/license obligations and complete clean-machine acceptance",
      "Review and sign the exact catalog with the production trust root",
      "Sign/notarize installers and configure the maintained update endpoint",
    ],
    files: [...files].map(([name, bytes]) => ({
      name,
      size: bytes.length,
      sha256: digest(bytes),
    })),
  };
  await mkdir(output); // Exclusive reservation; never replace an earlier proposal.
  for (const [name, bytes] of files)
    await writeFile(path.join(output, name), bytes, { flag: "wx" });
  // Receipt last. A partial write is never a completed handoff.
  await writeFile(path.join(output, "CATALOG_HANDOFF.json"), encode(handoff), {
    flag: "wx",
  });
  return handoff;
}

export async function main(arguments_) {
  const args = {};
  for (const argument of arguments_) {
    const match =
      /^--(directory|repository|tag|manifest-sha256|catalog-directory|public-key-sha256|output)=(.+)$/.exec(
        argument,
      );
    const key = argument === "--hosted" ? "hosted" : match?.[1];
    if (!key || Object.hasOwn(args, key))
      throw new Error("Unknown or duplicate catalog proposal argument");
    args[key] = key === "hosted" ? true : match[2];
  }
  for (const key of [
    "directory",
    "repository",
    "tag",
    "manifest-sha256",
    "catalog-directory",
    "public-key-sha256",
    "output",
  ])
    if (!args[key]) throw new Error(`Missing required --${key}`);
  const result = await prepareCatalogProposal({
    ...args,
    manifestSha256: args["manifest-sha256"],
    catalogDirectory: args["catalog-directory"],
    publicKeySha256: args["public-key-sha256"],
    transport: { onProgress: (name) => console.error(`PASS hosted ${name}`) },
  });
  console.log(
    JSON.stringify({
      status: result.status,
      artifacts: result.proposedArtifacts,
      catalogSigned: false,
    }),
  );
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
