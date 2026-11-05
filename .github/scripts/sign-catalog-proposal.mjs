// Sign the exact reviewed catalog bytes. Never refresh publishers or edit the
// shipping catalog. The separately retained handoff hash identifies the review;
// the operator remains responsible for release/source/clean-machine approval.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mergeCatalog } from "./prepare-catalog-proposal.mjs";
import {
  releaseBase,
  releaseSelections,
} from "../../scripts/prepare-native-release.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const validHash = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const encode = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const json = (bytes) =>
  JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
const developmentKeyHash =
  "203a1d0ff09c35d787e568a4cc4e746437454cf075a179960cfbb378597820d0";
const shipping = path.resolve(import.meta.dirname, "../../runtime-catalog");
const controls = [
  "catalog.proposed.json",
  "candidate-verification.json",
  "native-artifacts.json",
  "source-inventory.json",
  "release-manifest.json",
  "base-catalog.json",
  "base-catalog.sig",
  "base-public-key.txt",
];
const inside = (directory, file) => {
  const relative = path.relative(directory, file);
  return (
    !relative ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
};
const same = (actual, expected, message) => {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(message);
};

async function readControl(directory, name, expected) {
  const entry = await lstat(path.join(directory, name));
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 4 * 1024 * 1024)
    throw new Error(`Expected a bounded regular handoff file: ${name}`);
  const handle = await open(path.join(directory, name), "r");
  try {
    const opened = await handle.stat();
    if (
      opened.ino !== entry.ino ||
      opened.size !== entry.size ||
      !opened.isFile()
    )
      throw new Error(`Handoff file changed while opening: ${name}`);
    const chunks = [];
    let length = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      length += chunk.length;
      if (length > entry.size)
        throw new Error(`Handoff file grew while reading: ${name}`);
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (
      bytes.length !== entry.size ||
      (expected &&
        (bytes.length !== expected.size || digest(bytes) !== expected.sha256))
    )
      throw new Error(`Handoff file checksum/size mismatch: ${name}`);
    return bytes;
  } finally {
    await handle.close();
  }
}

function publicKey(raw) {
  return createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
    type: "spki",
    format: "der",
  });
}

export async function inspectHandoff({
  directory,
  handoffSha256,
  basePublicKeySha256,
}) {
  if (!validHash(handoffSha256) || !validHash(basePublicKeySha256))
    throw new Error(
      "Separately retained handoff and base public-key file hashes are required",
    );
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Handoff must be a real directory");
  directory = await realpath(directory);
  const receiptBytes = await readControl(directory, "CATALOG_HANDOFF.json");
  if (digest(receiptBytes) !== handoffSha256)
    throw new Error("Retained handoff hash mismatch");
  const handoff = json(receiptBytes);
  if (
    handoff.schemaVersion !== 1 ||
    handoff.catalogSigned !== false ||
    handoff.productionApproved !== false ||
    handoff.status !== "hosted-bytes-verified-awaiting-release-review" ||
    handoff.hostedVerification?.result !== "passed"
  )
    throw new Error(
      "Signing requires the reviewed handoff with complete public-byte verification",
    );
  const baseUrl = releaseBase(handoff.repository, handoff.tag);
  if (
    !Array.isArray(handoff.files) ||
    handoff.files.length !== controls.length ||
    new Set(handoff.files.map((item) => item.name)).size !== controls.length ||
    handoff.files.some(
      (item) =>
        !controls.includes(item.name) ||
        !validHash(item.sha256) ||
        !Number.isSafeInteger(item.size) ||
        item.size <= 0,
    )
  )
    throw new Error("Invalid handoff file inventory");
  same(
    (await readdir(directory)).sort(),
    [...controls, "CATALOG_HANDOFF.json"].sort(),
    "Handoff contains missing or unrecorded files",
  );
  const files = new Map();
  for (const name of controls)
    files.set(
      name,
      await readControl(
        directory,
        name,
        handoff.files.find((item) => item.name === name),
      ),
    );
  const keyBytes = files.get("base-public-key.txt");
  if (
    digest(keyBytes) !== basePublicKeySha256 ||
    handoff.publicKeySha256 !== basePublicKeySha256 ||
    digest(files.get("base-catalog.json")) !== handoff.baseCatalogSha256
  )
    throw new Error(
      "Base catalog differs from the retained trust root or catalog hash",
    );
  const raw = Buffer.from(keyBytes.toString("utf8").trim(), "base64");
  const signature = Buffer.from(
    files.get("base-catalog.sig").toString("utf8").trim(),
    "base64",
  );
  if (
    raw.length !== 32 ||
    signature.length !== 64 ||
    !verify(null, files.get("base-catalog.json"), publicKey(raw), signature)
  )
    throw new Error("Invalid base catalog signature");
  const base = json(files.get("base-catalog.json"));
  const native = json(files.get("native-artifacts.json"));
  const merged = mergeCatalog(base, native);
  const proposed = json(files.get("catalog.proposed.json"));
  if (
    proposed.schemaVersion !== 1 ||
    typeof proposed.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(proposed.generatedAt))
  )
    throw new Error("Invalid proposed catalog schema/timestamp");
  same(
    proposed.artifacts,
    merged.artifacts,
    "Proposed catalog differs from the immutable base/native merge",
  );
  same(
    handoff.addedIds,
    merged.added,
    "Handoff added IDs differ from the merge",
  );
  same(
    handoff.unchangedIds,
    merged.retained,
    "Handoff retained IDs differ from the merge",
  );
  if (
    handoff.baseArtifacts !== base.artifacts.length ||
    handoff.nativeArtifacts !== 12 ||
    native.length !== 12 ||
    handoff.proposedArtifacts !== proposed.artifacts.length
  )
    throw new Error("Handoff artifact counts differ from catalog contents");
  const manifest = json(files.get("release-manifest.json"));
  const report = json(files.get("candidate-verification.json"));
  if (
    !validHash(handoff.manifestSha256) ||
    digest(files.get("release-manifest.json")) !== handoff.manifestSha256 ||
    manifest.schemaVersion !== 1 ||
    manifest.repository !== handoff.repository ||
    manifest.tag !== handoff.tag ||
    manifest.runtimeCount !== 12 ||
    manifest.published !== false ||
    manifest.catalogSigned !== false ||
    !Array.isArray(manifest.files) ||
    report.schemaVersion !== 1 ||
    report.verification !== "byte-integrity-passed" ||
    report.catalogSigned !== false ||
    report.productionApproved !== false ||
    report.repository !== handoff.repository ||
    report.tag !== handoff.tag ||
    report.manifestSha256 !== handoff.manifestSha256
  )
    throw new Error("Candidate verification/manifest identity mismatch");
  if (
    manifest.files.length < 3 ||
    manifest.files.length > 998 ||
    new Set(manifest.files.map((item) => item.name)).size !==
      manifest.files.length ||
    manifest.files.some(
      (item) =>
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(item.name || "") ||
        ["release-manifest.json", "sha256sums.txt"].includes(
          item.name.toLowerCase(),
        ) ||
        !validHash(item.sha256) ||
        !Number.isSafeInteger(item.size) ||
        item.size <= 0,
    ) ||
    !Array.isArray(manifest.producers) ||
    manifest.producers.length !== 12 ||
    new Set(manifest.producers.map((item) => item.id)).size !== 12 ||
    manifest.producers.some(
      (item) =>
        !/^[1-9]\d*$/.test(String(item.run)) ||
        !/^[a-f0-9]{40}$/.test(item.sourceCommit || ""),
    )
  )
    throw new Error("Invalid candidate manifest file/producer inventory");
  if (
    !Array.isArray(report.files) ||
    report.files.length !== manifest.files.length + 2 ||
    report.fileCount !== report.files.length ||
    report.runtimeCount !== 12 ||
    new Set(report.files.map((item) => item.name)).size !==
      report.files.length ||
    report.files.some(
      (item) =>
        !validHash(item.sha256) ||
        !Number.isSafeInteger(item.size) ||
        item.size <= 0,
    )
  )
    throw new Error("Incomplete candidate verification inventory");
  const expected = new Map(report.files.map((item) => [item.name, item]));
  for (const item of manifest.files)
    same(
      expected.get(item.name),
      item,
      "Candidate file inventory differs from manifest",
    );
  for (const name of [
    "release-manifest.json",
    "native-artifacts.json",
    "source-inventory.json",
  ])
    same(
      expected.get(name),
      { name, size: files.get(name).length, sha256: digest(files.get(name)) },
      "Candidate control bytes differ from manifest/report",
    );
  if (
    !validHash(report.checksumFileSha256) ||
    expected.get("SHA256SUMS.txt")?.sha256 !== report.checksumFileSha256 ||
    report.checksumRecords !== report.files.length - 1 ||
    report.sourceInventorySha256 !== digest(files.get("source-inventory.json"))
  )
    throw new Error("Candidate checksum/source inventory pin mismatch");
  same(
    report.producers,
    manifest.producers,
    "Candidate producer identities differ from manifest",
  );
  const targets = { "linux-x64": [], "macos-x64": [], "macos-arm64": [] };
  for (const item of native) {
    const target = targets[`${item.platform}-${item.arch}`];
    const producer = manifest.producers.find(
      (producer) => producer.id === item.id,
    );
    const bytes = expected.get(`${item.id}.tar.gz`);
    if (
      !target ||
      !producer ||
      item.url !== `${baseUrl}/${item.id}.tar.gz` ||
      bytes?.sha256 !== item.sha256 ||
      bytes?.size !== item.size
    )
      throw new Error("Native runtime differs from reviewed release bytes");
    target.push({ ...item, run: producer.run, artifact: producer.artifact });
  }
  releaseSelections({ targets });
  const inventory = json(files.get("source-inventory.json"));
  if (
    !Array.isArray(inventory) ||
    !inventory.length ||
    report.sourceInventoryEntries !== inventory.length ||
    new Set(
      inventory.map((item) => `${item.file}:${item.name}:${item.version}`),
    ).size !== inventory.length ||
    inventory.some(
      (item) =>
        !validHash(item.sha256) ||
        expected.get(item.file)?.sha256 !== item.sha256 ||
        !new RegExp(
          `^source-${item.sha256}\\.(tar|tar\\.gz|tar\\.xz|tar\\.bz2|tgz)$`,
        ).test(item.file) ||
        !item.name ||
        !item.version ||
        !Array.isArray(item.usedBy) ||
        !item.usedBy.length ||
        new Set(item.usedBy).size !== item.usedBy.length ||
        item.usedBy.some((id) => !native.some((runtime) => runtime.id === id)),
    ) ||
    native.some(
      (runtime) => !inventory.some((item) => item.usedBy.includes(runtime.id)),
    ) ||
    report.sourceArchives !== new Set(inventory.map((item) => item.file)).size
  )
    throw new Error(
      "Source inventory does not cover the reviewed native runtimes",
    );
  const bytes = report.files.reduce((sum, item) => sum + item.size, 0);
  same(
    report.hostedVerification,
    handoff.hostedVerification,
    "Hosted verification receipts differ",
  );
  if (
    report.hostedVerification.result !== "passed" ||
    report.hostedVerification.baseUrl !== baseUrl ||
    report.hostedVerification.files !== report.files.length ||
    report.hostedVerification.bytes !== bytes ||
    report.payloadBytes !== bytes ||
    !Number.isFinite(Date.parse(report.hostedVerification.verifiedAt))
  )
    throw new Error("Hosted verification does not cover every candidate byte");
  return { directory, handoff, files, proposed };
}

function environmentKey() {
  const pem = process.env.STACKCABIN_CATALOG_PRIVATE_KEY;
  if (!pem)
    throw new Error(
      "Set STACKCABIN_CATALOG_PRIVATE_KEY only in the approved signing environment",
    );
  try {
    return createPrivateKey(pem.replaceAll("\\n", "\n"));
  } catch {
    throw new Error(
      "Invalid private signing key; key material was not written",
    );
  }
}

export async function signCatalogProposal({
  directory,
  handoffSha256,
  basePublicKeySha256,
  publicKeySha256,
  output,
  checkOnly = false,
  loadPrivateKey = environmentKey,
}) {
  if (!validHash(publicKeySha256) || publicKeySha256 === developmentKeyHash)
    throw new Error(
      "An independently selected production public-key file hash is required; the development key is forbidden",
    );
  const checked = await inspectHandoff({
    directory,
    handoffSha256,
    basePublicKeySha256,
  });
  const parent = await realpath(path.dirname(path.resolve(output)));
  output = path.join(parent, path.basename(path.resolve(output)));
  if (
    [checked.directory, await realpath(shipping)].some(
      (input) => inside(input, output) || inside(output, input),
    )
  )
    throw new Error(
      "Signing output must be separate from the handoff and shipping catalog",
    );
  try {
    await lstat(output);
    throw new Error("Signing output already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const catalog = checked.files.get("catalog.proposed.json");
  const plan = {
    schemaVersion: 1,
    scope: "catalog-signature-only",
    catalogSha256: digest(catalog),
    handoffSha256,
    basePublicKeySha256,
    publicKeySha256,
    artifactCount: checked.proposed.artifacts.length,
    repository: checked.handoff.repository,
    tag: checked.handoff.tag,
    manifestSha256: checked.handoff.manifestSha256,
    productionApproved: false,
  };
  if (checkOnly)
    return { ...plan, catalogSigned: false, privateKeyAccessed: false };
  const key = await loadPrivateKey(); // Only after the entire reviewed input and destination pass.
  if (key?.type !== "private" || key.asymmetricKeyType !== "ed25519")
    throw new Error("An Ed25519 private key is required");
  const publicBytes = Buffer.from(
    createPublicKey(key)
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64") + "\n",
  );
  if (digest(publicBytes) !== publicKeySha256)
    throw new Error(
      "Private key does not match the independently selected production public key",
    );
  const signature = sign(null, catalog, key);
  if (!verify(null, catalog, createPublicKey(key), signature))
    throw new Error("Generated catalog signature failed self-verification");
  const provenance = {
    developmentKey: false,
    generatedAt: new Date().toISOString(),
    ...plan,
    sourceInventorySha256: digest(checked.files.get("source-inventory.json")),
    artifacts: checked.proposed.artifacts.map(
      ({ id, url, sourceUrl, sha256 }) => ({ id, url, sourceUrl, sha256 }),
    ),
  };
  const files = new Map([
    ["catalog.json", catalog],
    ["catalog.sig", Buffer.from(signature.toString("base64") + "\n")],
    ["public-key.txt", publicBytes],
    ["provenance.json", encode(provenance)],
  ]);
  await mkdir(output);
  for (const [name, bytes] of files)
    await writeFile(path.join(output, name), bytes, { flag: "wx" });
  const receipt = {
    ...plan,
    catalogSigned: true,
    signedAt: provenance.generatedAt,
    files: [...files].map(([name, bytes]) => ({
      name,
      size: bytes.length,
      sha256: digest(bytes),
    })),
  };
  await writeFile(path.join(output, "SIGNING_RECEIPT.json"), encode(receipt), {
    flag: "wx",
  });
  return receipt;
}

export async function main(arguments_, dependencies = {}) {
  const args = {};
  for (const argument of arguments_) {
    const match =
      /^--(directory|handoff-sha256|base-public-key-sha256|public-key-sha256|output)=(.+)$/.exec(
        argument,
      );
    const key = argument === "--check-only" ? "check-only" : match?.[1];
    if (!key || Object.hasOwn(args, key))
      throw new Error("Unknown or duplicate catalog signing argument");
    args[key] = key === "check-only" ? true : match[2];
  }
  for (const name of [
    "directory",
    "handoff-sha256",
    "base-public-key-sha256",
    "public-key-sha256",
    "output",
  ])
    if (!args[name]) throw new Error(`Missing required --${name}`);
  const result = await signCatalogProposal({
    ...dependencies,
    directory: args.directory,
    output: args.output,
    handoffSha256: args["handoff-sha256"],
    basePublicKeySha256: args["base-public-key-sha256"],
    publicKeySha256: args["public-key-sha256"],
    checkOnly: args["check-only"] === true,
  });
  console.log(JSON.stringify(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
