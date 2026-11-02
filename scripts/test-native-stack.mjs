import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256 } from "./catalog-lib.mjs";
import { verifyNativeStack } from "./native-stack-lib.mjs";

async function fixture(options) {
  const folder = await mkdtemp(
    path.join(os.tmpdir(), "stackcabin-native-stack-"),
  );
  const build = { component: "php", version: "8.4.27" };
  const sourceBytes = Buffer.from("reviewed-publisher-source");
  const source = {
    ...build,
    sourceUrl: "https://example.test/php.tar.gz",
    sourceSha256: sha256(sourceBytes),
  };
  const bytes = Buffer.from("reviewed-test-archive");
  const platform = options.platform || "macos";
  const id = `php-8.4.27-${platform}-arm64`;
  const metadata = {
    ...build,
    id,
    platform,
    arch: "arm64",
    sourceUrl: source.sourceUrl,
    archive: "tar.gz",
    sha256: sha256(bytes),
    size: bytes.length,
    ...(platform === "macos" ? { minimumOsVersion: "14.0" } : {}),
  };
  options.metadata?.(metadata);
  const provenance = {
    sourceUrl: source.sourceUrl,
    sourceSha256: source.sourceSha256,
    verification: { ...build, result: "passed" },
    minimumOsVersion: metadata.minimumOsVersion,
  };
  options.provenance?.(provenance);
  options.source?.(source);
  await writeFile(path.join(folder, id + ".json"), JSON.stringify(metadata));
  await writeFile(
    path.join(folder, id + ".tar.gz"),
    options.archive ? options.archive(bytes) : bytes,
  );
  if (!options.omitProvenance)
    await writeFile(
      path.join(folder, id + "-provenance.json"),
      JSON.stringify(provenance),
    );
  if (!options.omitSource)
    await writeFile(
      path.join(folder, id + "-source.tar.gz"),
      options.sourceArchive ? options.sourceArchive(sourceBytes) : sourceBytes,
    );
  return { folder, build, source, platform };
}

async function check(options = {}) {
  const { folder, build, source, platform } = await fixture(options);
  try {
    return await verifyNativeStack(
      folder,
      platform,
      "arm64",
      options.duplicate ? [build, build] : [build],
      [source],
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test("accepts a complete identity and checksum before test signing", async () => {
  assert.equal((await check())[0].id, "php-8.4.27-macos-arm64");
});
test("rejects architecture, source or identity substitutions", async () => {
  for (const change of [
    (m) => (m.arch = "x64"),
    (m) => (m.sourceUrl += "-other"),
    (m) => (m.id = "../../other"),
  ])
    await assert.rejects(check({ metadata: change }), /reviewed selection/);
});
test("rejects packages requiring a later macOS than the baseline", async () => {
  await assert.rejects(
    check({ metadata: (m) => (m.minimumOsVersion = "15.0") }),
    /reviewed selection/,
  );
});
test("accepts equivalent and older macOS baseline versions", async () => {
  for (const minimum of ["14.0.0", "13.0"])
    assert.equal(
      (await check({ metadata: (m) => (m.minimumOsVersion = minimum) })).length,
      1,
    );
});
test("rejects a truncated archive", async () => {
  await assert.rejects(
    check({ archive: (b) => b.subarray(1) }),
    /size mismatch/,
  );
});
test("rejects corrupt bytes even when the size matches", async () => {
  await assert.rejects(
    check({ archive: (b) => Buffer.alloc(b.length) }),
    /checksum mismatch/,
  );
});
test("rejects duplicate native runtime identities", async () => {
  await assert.rejects(check({ duplicate: true }), /Duplicate/);
});

test("requires a reviewed source checksum and matching provenance", async () => {
  for (const sourceSha256 of [undefined, "", "not-a-checksum", "a".repeat(64)])
    await assert.rejects(
      check({ source: (source) => (source.sourceSha256 = sourceSha256) }),
      /reviewed selection/,
    );
  for (const change of [
    (p) => (p.sourceUrl += "-other"),
    (p) => (p.sourceSha256 = "a".repeat(64)),
    (p) => (p.minimumOsVersion = "15.0"),
  ])
    await assert.rejects(check({ provenance: change }), /provenance/);
});

test("requires a successful relocation probe for the exact component/version", async () => {
  for (const change of [
    (p) => delete p.verification,
    (p) => (p.verification.result = "failed"),
    (p) => (p.verification.component = "postgres"),
    (p) => (p.verification.version = "8.5.12"),
  ])
    await assert.rejects(check({ provenance: change }), /provenance/);
});

test("rejects substituted source bytes despite matching claimed provenance", async () => {
  for (const sourceArchive of [
    (b) => b.subarray(1),
    (b) => Buffer.alloc(b.length),
  ])
    await assert.rejects(check({ sourceArchive }), /source archive checksum/);
});

test("rejects missing source or provenance instead of accepting legacy candidates", async () => {
  for (const options of [{ omitSource: true }, { omitProvenance: true }])
    await assert.rejects(check(options), { code: "ENOENT" });
});

test("accepts verified Linux packages without a macOS minimum version", async () => {
  assert.equal((await check({ platform: "linux" }))[0].platform, "linux");
});
