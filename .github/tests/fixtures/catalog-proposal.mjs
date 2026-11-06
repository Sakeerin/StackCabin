import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture, digest, jsonBytes } from "./native-release.mjs";

// Synthetic, stable metadata: promoting/rotating the shipping catalog must not
// turn test fixtures into production inputs or collide with its new native IDs.
function baseCatalog() {
  const artifacts = [];
  for (const [platform, arch] of [
    ["windows", "x64"],
    ["linux", "x64"],
    ["macos", "x64"],
    ["macos", "arm64"],
  ]) {
    const versions = [
      ["node", "22.1.0"],
      ["node", "24.1.0"],
      ["caddy", "2.1.0"],
      ["composer", "2.1.0"],
      ["pnpm", "10.1.0"],
      ["yarn", "1.22.22"],
      ["cacert", "1.0.0"],
    ];
    if (platform === "windows")
      versions.push(
        ["php", "8.4.1"],
        ["php", "8.5.1"],
        ["mariadb", "12.3.1"],
        ["postgres", "18.1"],
      );
    for (const [component, version] of versions) {
      const id = `${component}-${version}-${platform}-${arch}`;
      artifacts.push({
        id,
        component,
        version,
        platform,
        arch,
        url: `https://example.test/${id}.tar.gz`,
        sha256: "b".repeat(64),
        archive: "tar.gz",
        stripComponents: 1,
        executables: { [component]: `bin/${component}` },
        license: "fixture-only",
        sourceUrl: "https://example.test/source",
        size: component === "node" ? 0 : 1,
      });
    }
  }
  return { schemaVersion: 1, generatedAt: "2026-01-01T00:00:00Z", artifacts };
}

export async function proposalFixture(t, changeBase) {
  const f = await fixture(t);
  const catalogDirectory = path.join(f.root, "base");
  await mkdir(catalogDirectory);
  const base = baseCatalog();
  changeBase?.(base, f);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyBytes = Buffer.from(
    publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64") + "\n",
  );
  const resign = async () => {
    const bytes = jsonBytes(base);
    await writeFile(path.join(catalogDirectory, "catalog.json"), bytes);
    await writeFile(
      path.join(catalogDirectory, "catalog.sig"),
      sign(null, bytes, privateKey).toString("base64") + "\n",
    );
    await writeFile(path.join(catalogDirectory, "public-key.txt"), keyBytes);
  };
  await resign();
  return {
    ...f,
    base,
    resign,
    settings: {
      ...f.options,
      directory: f.directory,
      catalogDirectory,
      publicKeySha256: digest(keyBytes),
      output: path.join(f.root, "proposal"),
    },
  };
}
