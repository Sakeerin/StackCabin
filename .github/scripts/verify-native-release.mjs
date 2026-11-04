// Verify transfer integrity against a separately retained manifest digest.
// Assembly policy, license review, VM acceptance and signing remain separate.
import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  releaseBase,
  releaseSelections,
} from "../../scripts/prepare-native-release.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const validHash = (value) => /^[a-f0-9]{64}$/.test(value || "");
const assetName = (name) =>
  typeof name === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name) &&
  !name.endsWith(".") &&
  !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
const json = (bytes) =>
  JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
const controls = new Set([
  "native-artifacts.json",
  "source-inventory.json",
  "RELEASE_REVIEW.txt",
]);

async function fingerprint(directory, name, expected, capture = false) {
  const file = path.join(directory, name);
  const entry = await lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink())
    throw new Error(`Expected a regular asset: ${name}`);
  if (capture && entry.size > 4 * 1024 * 1024)
    throw new Error(`Control file exceeds its size limit: ${name}`);
  if (expected && entry.size !== expected.size)
    throw new Error(`Asset size mismatch: ${name}`);
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.ino !== entry.ino ||
      // Some Windows filesystems report dev=0 for paths but a volume ID for
      // open handles. Compare it when available; always bind inode and bytes.
      (entry.dev !== 0 && opened.dev !== entry.dev) ||
      opened.size !== entry.size
    )
      throw new Error(`Asset changed while opening: ${name}`);
    const digest = createHash("sha256");
    const chunks = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > entry.size)
        throw new Error(`Asset grew while reading: ${name}`);
      digest.update(chunk);
      if (capture) chunks.push(chunk);
    }
    const sha256 = digest.digest("hex");
    if (size !== entry.size || (expected && expected.sha256 !== sha256))
      throw new Error(`Asset checksum mismatch: ${name}`);
    return {
      name,
      size,
      sha256,
      ...(capture ? { bytes: Buffer.concat(chunks) } : {}),
    };
  } finally {
    await handle.close();
  }
}

export async function verifyCandidate(
  directory,
  { repository, tag, manifestSha256 },
) {
  const base = releaseBase(repository, tag);
  if (!validHash(manifestSha256))
    throw new Error("A separately retained manifest SHA-256 is required");
  if (
    !(await lstat(directory)).isDirectory() ||
    (await lstat(directory)).isSymbolicLink()
  )
    throw new Error("Candidate directory must be a real directory");
  directory = await realpath(directory);
  const manifestFile = await fingerprint(
    directory,
    "release-manifest.json",
    null,
    true,
  );
  if (manifestFile.sha256 !== manifestSha256)
    throw new Error("Trusted manifest checksum mismatch");
  const manifest = json(manifestFile.bytes);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.repository !== repository ||
    manifest.tag !== tag ||
    manifest.published !== false ||
    manifest.catalogSigned !== false ||
    manifest.runtimeCount !== 12 ||
    !Array.isArray(manifest.producers) ||
    manifest.producers.length !== 12 ||
    !Array.isArray(manifest.files) ||
    manifest.files.length < 3 ||
    manifest.files.length > 1000
  )
    throw new Error("Invalid candidate manifest identity or inventory");
  const expected = new Map();
  const folded = new Set();
  for (const entry of manifest.files) {
    if (
      !assetName(entry.name) ||
      expected.has(entry.name) ||
      folded.has(entry.name.toLowerCase()) ||
      ["release-manifest.json", "sha256sums.txt"].includes(
        entry.name.toLowerCase(),
      ) ||
      !validHash(entry.sha256) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size <= 0 ||
      entry.size > 2 ** 31 - 1
    )
      throw new Error("Invalid, duplicate or unsafe manifest asset");
    expected.set(entry.name, entry);
    folded.add(entry.name.toLowerCase());
  }
  for (const name of controls)
    if (!expected.has(name))
      throw new Error(`Missing candidate control: ${name}`);
  expected.set("release-manifest.json", manifestFile);
  const checksumFile = await fingerprint(
    directory,
    "SHA256SUMS.txt",
    null,
    true,
  );
  const checks = new Map();
  for (const line of checksumFile.bytes
    .toString("utf8")
    .split(/\r?\n/)
    .filter(Boolean)) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,199})$/.exec(
      line,
    );
    if (
      !match ||
      !expected.has(match[2]) ||
      checks.has(match[2]) ||
      expected.get(match[2]).sha256 !== match[1]
    )
      throw new Error("Checksum inventory differs from trusted manifest");
    checks.set(match[2], match[1]);
  }
  if (checks.size !== expected.size)
    throw new Error("Incomplete candidate checksum inventory");
  const names = await readdir(directory);
  if (
    names.length !== expected.size + 1 ||
    names.some((name) => name !== "SHA256SUMS.txt" && !expected.has(name))
  )
    throw new Error("Candidate directory has missing or unrecorded files");
  const checked = [manifestFile, checksumFile];
  const captured = new Map();
  for (const entry of manifest.files) {
    const actual = await fingerprint(
      directory,
      entry.name,
      entry,
      controls.has(entry.name),
    );
    checked.push(actual);
    if (actual.bytes) captured.set(entry.name, actual.bytes);
  }
  const runtimes = json(captured.get("native-artifacts.json"));
  const inventory = json(captured.get("source-inventory.json"));
  if (
    !Array.isArray(runtimes) ||
    runtimes.length !== 12 ||
    new Set(runtimes.map((item) => item.id)).size !== 12 ||
    !Array.isArray(inventory) ||
    !inventory.length ||
    new Set(manifest.producers.map((item) => item.id)).size !== 12
  )
    throw new Error("Invalid native or source inventory");
  const targets = { "linux-x64": [], "macos-arm64": [], "macos-x64": [] };
  for (const runtime of runtimes) {
    const producer = manifest.producers.find((item) => item.id === runtime.id);
    const target = `${runtime.platform}-${runtime.arch}`;
    const file = expected.get(`${runtime.id}.tar.gz`);
    if (
      !producer ||
      !targets[target] ||
      runtime.id !== `${runtime.component}-${runtime.version}-${target}` ||
      !/^[1-9]\d*$/.test(producer.run || "") ||
      !assetName(producer.artifact) ||
      !/^[a-f0-9]{40}$/.test(producer.sourceCommit || "") ||
      runtime.url !== `${base}/${runtime.id}.tar.gz` ||
      !file ||
      file.sha256 !== runtime.sha256 ||
      file.size !== runtime.size
    )
      throw new Error(
        "Native inventory differs from candidate identity or bytes",
      );
    for (const suffix of [".json", "-provenance.json"])
      if (!expected.has(`${runtime.id}${suffix}`))
        throw new Error(`Missing original metadata: ${runtime.id}`);
    targets[target].push({
      ...runtime,
      run: producer.run,
      artifact: producer.artifact,
    });
  }
  releaseSelections({ targets });
  const sources = new Set();
  const sourceRecords = new Set();
  for (const source of inventory) {
    const file = expected.get(source.file);
    const key = `${source.file}:${source.name}:${source.version}`;
    if (
      !file ||
      !validHash(source.sha256) ||
      file.sha256 !== source.sha256 ||
      !new RegExp(
        `^source-${source.sha256}\\.(tar|tar\\.gz|tar\\.xz|tar\\.bz2|tgz)$`,
      ).test(source.file) ||
      !source.name ||
      !source.version ||
      sourceRecords.has(key) ||
      !Array.isArray(source.usedBy) ||
      !source.usedBy.length ||
      new Set(source.usedBy).size !== source.usedBy.length ||
      source.usedBy.some((id) => !runtimes.some((runtime) => runtime.id === id))
    )
      throw new Error(
        "Source inventory differs from checked assets or runtimes",
      );
    sources.add(source.file);
    sourceRecords.add(key);
  }
  if (
    runtimes.some(
      (runtime) =>
        !inventory.some((source) => source.usedBy.includes(runtime.id)),
    ) ||
    manifest.files.some(
      (entry) =>
        /^source-[a-f0-9]{64}\./.test(entry.name) && !sources.has(entry.name),
    )
  )
    throw new Error("Incomplete source/runtime references");
  const report = {
    schemaVersion: 1,
    verification: "byte-integrity-passed",
    verifiedAt: new Date().toISOString(),
    repository,
    tag,
    manifestSha256,
    checksumFileSha256: checksumFile.sha256,
    sourceInventorySha256: expected.get("source-inventory.json").sha256,
    runtimeCount: runtimes.length,
    fileCount: checked.length,
    checksumRecords: checks.size,
    sourceArchives: sources.size,
    sourceInventoryEntries: inventory.length,
    ubuntuSourceBundles: new Set(
      inventory
        .filter((item) => item.kind === "ubuntu-source-package")
        .map((item) => item.file),
    ).size,
    payloadBytes: checked.reduce((sum, item) => sum + item.size, 0),
    catalogSigned: false,
    productionApproved: false,
    hostedVerification: { result: "not-requested" },
    producers: manifest.producers,
    files: checked
      .map(({ name, size, sha256 }) => ({ name, size, sha256 }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
  return { directory, base, report };
}

function httpsAssetUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    ![
      "github.com",
      "release-assets.githubusercontent.com",
      "objects.githubusercontent.com",
      "github-releases.githubusercontent.com",
    ].includes(url.hostname)
  )
    throw new Error(
      "Release downloads require HTTPS on GitHub release hosts without credentials",
    );
  return url;
}

function abortable(start, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = () => reject(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
  });
  const operation = Promise.resolve().then(() => {
    signal.throwIfAborted();
    return start();
  });
  return Promise.race([operation, aborted]).finally(() =>
    signal.removeEventListener("abort", listener),
  );
}

export async function verifyHostedAsset(
  value,
  expected,
  { fetchImpl = fetch, timeoutMs = 120_000, signal } = {},
) {
  if (
    !assetName(expected.name) ||
    !validHash(expected.sha256) ||
    !Number.isSafeInteger(expected.size) ||
    expected.size <= 0
  )
    throw new Error("Invalid expected hosted asset identity");
  let url = httpsAssetUrl(value);
  const controller = new AbortController();
  const active = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(
    () => controller.abort(new Error("Hosted asset deadline exceeded")),
    timeoutMs,
  );
  let response, reader;
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      response = await abortable(
        () =>
          fetchImpl(url.href, {
            redirect: "manual",
            credentials: "omit",
            headers: { "Accept-Encoding": "identity" },
            signal: active,
          }),
        active,
      );
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      void response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      if (!location || redirects === 5)
        throw new Error("Missing or excessive hosted redirects");
      url = httpsAssetUrl(new URL(location, url));
    }
    if (response.status !== 200)
      throw new Error(
        `Hosted asset returned HTTP ${response.status}: ${expected.name}`,
      );
    const encoding = response.headers.get("content-encoding");
    const length = response.headers.get("content-length");
    if (
      (encoding && encoding.toLowerCase() !== "identity") ||
      (length !== null &&
        (!/^\d+$/.test(length) || Number(length) !== expected.size))
    )
      throw new Error(
        `Hosted asset encoding/length mismatch: ${expected.name}`,
      );
    if (!response.body)
      throw new Error(`Missing hosted asset body: ${expected.name}`);
    reader = response.body.getReader();
    const digest = createHash("sha256");
    let size = 0;
    while (true) {
      const chunk = await abortable(() => reader.read(), active);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > expected.size)
        throw new Error(`Hosted asset exceeds expected size: ${expected.name}`);
      digest.update(chunk.value);
    }
    if (size !== expected.size || digest.digest("hex") !== expected.sha256)
      throw new Error(`Hosted asset checksum/size mismatch: ${expected.name}`);
    return { name: expected.name, size, sha256: expected.sha256 };
  } catch (error) {
    if (active.aborted)
      throw new Error(
        `Hosted verification cancelled or timed out: ${expected.name}`,
      );
    if (error instanceof TypeError)
      throw new Error(`Hosted transport failed: ${expected.name}`);
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
    else void response?.body?.cancel().catch(() => {});
  }
}

export async function verifyHostedCandidate(
  candidate,
  {
    fetchImpl = fetch,
    signal,
    timeoutMs = 120_000,
    deadlineMs = 1_800_000,
    onProgress = () => {},
  } = {},
) {
  const controller = new AbortController();
  const active = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    let files = 0,
      bytes = 0;
    for (const expected of candidate.report.files) {
      const checked = await verifyHostedAsset(
        `${candidate.base}/${expected.name}`,
        expected,
        { fetchImpl, signal: active, timeoutMs },
      );
      files++;
      bytes += checked.size;
      onProgress(checked.name);
    }
    return {
      ...candidate.report,
      hostedVerification: {
        result: "passed",
        verifiedAt: new Date().toISOString(),
        baseUrl: candidate.base,
        files,
        bytes,
      },
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function main(arguments_) {
  const args = {};
  for (const argument of arguments_) {
    const match =
      /^--(directory|repository|tag|manifest-sha256|report)=(.+)$/.exec(
        argument,
      );
    const key = argument === "--hosted" ? "hosted" : match?.[1];
    if (!key || Object.hasOwn(args, key))
      throw new Error("Unknown or duplicate native verification argument");
    args[key] = key === "hosted" ? true : match[2];
  }
  if (
    ["directory", "repository", "tag", "manifest-sha256", "report"].some(
      (key) => !args[key],
    )
  )
    throw new Error(
      "Required: --directory --repository --tag --manifest-sha256 --report; optionally --hosted",
    );
  const candidate = await verifyCandidate(args.directory, {
    repository: args.repository,
    tag: args.tag,
    manifestSha256: args["manifest-sha256"],
  });
  const reportFile = path.resolve(args.report);
  const parent = await realpath(path.dirname(reportFile));
  const output = path.join(parent, path.basename(reportFile));
  const relative = path.relative(candidate.directory, output);
  if (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  )
    throw new Error(
      "Verification report must stay outside the candidate directory",
    );
  const report = args.hosted
    ? await verifyHostedCandidate(candidate, {
        onProgress: (name) => console.error(`PASS hosted ${name}`),
      })
    : candidate.report;
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      verification: report.verification,
      files: report.fileCount,
      manifestSha256: report.manifestSha256,
      hosted: report.hostedVerification.result,
    }),
  );
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
