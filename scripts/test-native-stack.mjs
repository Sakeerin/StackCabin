import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256 } from "./catalog-lib.mjs";
import { verifyNativeStack } from "./native-stack-lib.mjs";

async function fixture(changeMetadata = () => {}, changeBytes = (b) => b) {
  const folder = await mkdtemp(
    path.join(os.tmpdir(), "stackcabin-native-stack-"),
  );
  const build = { component: "php", version: "8.4.27" };
  const source = { ...build, sourceUrl: "https://example.test/php.tar.gz" };
  const bytes = Buffer.from("reviewed-test-archive");
  const id = "php-8.4.27-macos-arm64";
  const metadata = {
    ...build,
    id,
    platform: "macos",
    arch: "arm64",
    sourceUrl: source.sourceUrl,
    archive: "tar.gz",
    sha256: sha256(bytes),
    size: bytes.length,
    minimumOsVersion: "14.0",
  };
  changeMetadata(metadata);
  await writeFile(path.join(folder, id + ".json"), JSON.stringify(metadata));
  await writeFile(path.join(folder, id + ".tar.gz"), changeBytes(bytes));
  return { folder, build, source };
}

async function check(changeMetadata, changeBytes, duplicate = false) {
  const { folder, build, source } = await fixture(changeMetadata, changeBytes);
  try {
    return await verifyNativeStack(
      folder,
      "macos",
      "arm64",
      duplicate ? [build, build] : [build],
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
    await assert.rejects(check(change), /reviewed selection/);
});
test("rejects packages requiring a later macOS than the baseline", async () => {
  await assert.rejects(
    check((m) => (m.minimumOsVersion = "15.0")),
    /reviewed selection/,
  );
});
test("rejects a truncated archive", async () => {
  await assert.rejects(
    check(undefined, (b) => b.subarray(1)),
    /size mismatch/,
  );
});
test("rejects corrupt bytes even when the size matches", async () => {
  await assert.rejects(
    check(undefined, (b) => Buffer.alloc(b.length)),
    /checksum mismatch/,
  );
});
test("rejects duplicate native runtime identities", async () => {
  await assert.rejects(check(undefined, undefined, true), /Duplicate/);
});
