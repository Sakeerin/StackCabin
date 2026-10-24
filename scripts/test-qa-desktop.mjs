import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { generateKeyPairSync, createPublicKey, sign } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { sha256 } from "./catalog-lib.mjs";
import { verifyQaDesktopPack } from "./qa-desktop-lib.mjs";

async function fixture(mutate = () => {}) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "stackcabin-qa-desktop-"),
  );
  const artifacts = [];
  for (const [component, version] of [
    ["php", "8.4.27"],
    ["php", "8.5.12"],
    ["node", "22.1.0"],
    ["node", "24.1.0"],
    ...[
      "caddy",
      "composer",
      "pnpm",
      "yarn",
      "cacert",
      "mariadb",
      "postgres",
    ].map((c) => [c, "1.0.0"]),
  ]) {
    const id = `${component}-${version}-linux-x64`;
    const bytes = Buffer.from(id);
    const artifact = {
      id,
      component,
      version,
      platform: "linux",
      arch: "x64",
      url: "https://example.test/" + id,
      sha256: sha256(bytes),
      size: bytes.length,
    };
    artifacts.push(artifact);
    await writeFile(path.join(directory, artifact.sha256), bytes);
  }
  mutate(artifacts);
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, artifacts }));
  const { privateKey } = generateKeyPairSync("ed25519");
  const raw = createPublicKey(privateKey)
    .export({ type: "spki", format: "der" })
    .subarray(-32);
  await writeFile(path.join(directory, "catalog.json"), bytes);
  await writeFile(
    path.join(directory, "catalog.sig"),
    sign(null, bytes, privateKey).toString("base64"),
  );
  await writeFile(
    path.join(directory, "public-key.txt"),
    raw.toString("base64"),
  );
  await writeFile(
    path.join(directory, "provenance.json"),
    JSON.stringify({ developmentKey: true }),
  );
  return { directory, artifacts };
}
async function check(callback, mutate) {
  const fixtureData = await fixture(mutate);
  try {
    await callback(fixtureData);
  } finally {
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
}
test("accepts a complete signed QA stack with matching archives", async () => {
  await check(async ({ directory }) =>
    assert.equal(
      (await verifyQaDesktopPack(directory, "linux", "x64")).artifacts.length,
      11,
    ),
  );
});
test("rejects a missing runtime branch before preparing a desktop build", async () => {
  await check(
    async ({ directory }) =>
      assert.rejects(
        verifyQaDesktopPack(directory, "linux", "x64"),
        /Incomplete desktop QA stack/,
      ),
    (items) => items.splice(1, 1),
  );
});
test("rejects a changed archive despite a valid signed catalog", async () => {
  await check(async ({ directory, artifacts }) => {
    await writeFile(
      path.join(directory, artifacts[0].sha256),
      Buffer.alloc(artifacts[0].size),
    );
    await assert.rejects(
      verifyQaDesktopPack(directory, "linux", "x64"),
      /checksum mismatch/,
    );
  });
});
test("rejects catalog tampering before accepting runtime bytes", async () => {
  await check(async ({ directory }) => {
    await writeFile(path.join(directory, "catalog.json"), "{}");
    await assert.rejects(
      verifyQaDesktopPack(directory, "linux", "x64"),
      /Invalid catalog signature/,
    );
  });
});
test("refuses an unmarked production catalog in the QA pipeline", async () => {
  await check(async ({ directory }) => {
    await writeFile(
      path.join(directory, "provenance.json"),
      JSON.stringify({ developmentKey: false }),
    );
    await assert.rejects(
      verifyQaDesktopPack(directory, "linux", "x64"),
      /explicitly marked development/,
    );
  });
});
