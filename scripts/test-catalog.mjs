import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyCatalog } from "./catalog-lib.mjs";

function releaseArtifacts() {
  const artifacts = [];
  for (const [platform, arch] of [
    ["windows", "x64"],
    ["linux", "x64"],
    ["macos", "x64"],
    ["macos", "arm64"],
  ])
    for (const [component, version] of [
      ["node", "22.1.0"],
      ["node", "24.1.0"],
      ["php", "8.4.1"],
      ["php", "8.5.1"],
      ["composer", "2.1.0"],
      ["caddy", "2.1.0"],
      ["mariadb", "12.3.1"],
      ["postgres", "18.1.0"],
      ["pnpm", "10.1.0"],
      ["yarn", "1.22.22"],
    ]) {
      const id = `${component}-${version}-${platform}-${arch}`;
      artifacts.push({
        id,
        component,
        version,
        platform,
        arch,
        url: `https://example.test/${id}.tar.gz`,
        sha256: "a".repeat(64),
        archive: "tar.gz",
        stripComponents: 1,
        executables: { [component]: `bin/${component}` },
        license: "test-fixture",
        sourceUrl: "https://example.test/source",
        size: 1,
        ...(platform === "macos" &&
        ["php", "mariadb", "postgres"].includes(component)
          ? { minimumOsVersion: "14.0" }
          : {}),
      });
    }
  return artifacts;
}

async function verifyFixture(change) {
  const folder = await mkdtemp(
    path.join(os.tmpdir(), "stackcabin-catalog-test-"),
  );
  try {
    const artifacts = releaseArtifacts();
    change?.(artifacts);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const bytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: "2026-01-01T00:00:00Z",
        artifacts,
      }),
    );
    await writeFile(path.join(folder, "catalog.json"), bytes);
    await writeFile(
      path.join(folder, "catalog.sig"),
      sign(null, bytes, privateKey).toString("base64"),
    );
    await writeFile(
      path.join(folder, "public-key.txt"),
      publicKey
        .export({ format: "der", type: "spki" })
        .subarray(-32)
        .toString("base64"),
    );
    await writeFile(
      path.join(folder, "provenance.json"),
      JSON.stringify({ developmentKey: false }),
    );
    return await verifyCatalog(folder, true);
  } finally {
    // This exact, freshly allocated temporary directory belongs to this test.
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(folder).startsWith("stackcabin-catalog-test-"));
    await rm(folder, { recursive: true, force: true });
  }
}

test("a signed complete release matrix with macOS 14 libraries passes", async () => {
  assert.equal((await verifyFixture()).artifacts.length, 40);
});
test("a signed PHP pack requiring macOS 15 is blocked", async () => {
  await assert.rejects(
    verifyFixture((items) => {
      items.find(
        (a) => a.component === "php" && a.platform === "macos",
      ).minimumOsVersion = "15.0";
    }),
    /requires macOS 15/,
  );
});
test("unknown native library baselines cannot enter a release", async () => {
  await assert.rejects(
    verifyFixture((items) => {
      delete items.find(
        (a) => a.component === "postgres" && a.platform === "macos",
      ).minimumOsVersion;
    }),
    /missing minimum macOS/,
  );
});
test("malformed minimum OS metadata is rejected", async () => {
  await assert.rejects(
    verifyFixture((items) => {
      items.find(
        (a) => a.component === "mariadb" && a.platform === "macos",
      ).minimumOsVersion = "14.invalid";
    }),
    /Release blocked/,
  );
});
test("both PHP branches are required on every target", async () => {
  await assert.rejects(
    verifyFixture((items) => {
      items.splice(
        items.findIndex(
          (a) =>
            a.component === "php" &&
            a.version.startsWith("8.5") &&
            a.platform === "linux",
        ),
        1,
      );
    }),
    /missing php 8.5/,
  );
});
