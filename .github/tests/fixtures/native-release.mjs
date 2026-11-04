import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
const workspace = path.resolve(import.meta.dirname, "../../..");
const temporaryRoot = path.join(workspace, "artifacts");
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export const jsonBytes = (value) =>
  Buffer.from(JSON.stringify(value, null, 2) + "\n");
export const repository = "Sakeerin/StackCabin",
  tag = "native-verification-fixture";
export const base = `https://github.com/${repository}/releases/download/${tag}`;

export async function fixture(t) {
  await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(path.join(temporaryRoot, "release-byte-tests-"));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.ok(
      resolved.startsWith(path.join(temporaryRoot, "release-byte-tests-")),
    );
    assert.ok(!(await lstat(resolved)).isSymbolicLink());
    for (const name of await readdir(resolved)) {
      const file = path.join(resolved, name);
      if ((await lstat(file)).isSymbolicLink()) await unlink(file);
    }
    await rm(resolved, { recursive: true, force: true });
  });
  const directory = path.join(root, "candidate");
  await mkdir(directory);
  // Tiny byte fixtures exercise transfer/inventory checks. Assembly policy and
  // real runtime/source archives have separate tests and hosted integration.
  const files = new Map([
    ["RELEASE_REVIEW.txt", Buffer.from("Fixture; no production approval\n")],
  ]);
  const runtimes = [],
    producers = [],
    inventory = [];
  for (const target of ["linux-x64", "macos-arm64", "macos-x64"]) {
    for (const [component, version] of [
      ["php", "8.4.27"],
      ["php", "8.5.12"],
      ["mariadb", "12.3.3"],
      ["postgres", "18.6"],
    ]) {
      const [platform, arch] = target.split("-");
      const id = `${component}-${version}-${target}`;
      const bytes = Buffer.from(`binary fixture for ${id}`);
      const runtime = {
        id,
        component,
        version,
        platform,
        arch,
        url: `${base}/${id}.tar.gz`,
        sha256: digest(bytes),
        size: bytes.length,
        archive: "tar.gz",
        stripComponents: 1,
        license: "fixture-only",
        sourceUrl: "https://example.test/source.tar.gz",
        executables: Object.fromEntries(
          {
            php: ["php", "php-fpm"],
            mariadb: ["mariadbd", "mariadb", "mariadb-dump", "install-db"],
            postgres: ["postgres", "initdb", "psql", "pg_dump", "pg_ctl"],
          }[component].map((tool) => [tool, `bin/${tool}`]),
        ),
        ...(platform === "macos" ? { minimumOsVersion: "14.0" } : {}),
      };
      runtimes.push(runtime);
      producers.push({
        id,
        run: "12345",
        artifact: `${component}-${version}-${target}`,
        sourceCommit: "a".repeat(40),
      });
      files.set(`${id}.tar.gz`, bytes);
      files.set(`${id}.json`, jsonBytes(runtime));
      files.set(`${id}-provenance.json`, jsonBytes({ fixture: true }));
    }
  }
  const source = Buffer.from("publisher source fixture");
  const sourceName = `source-${digest(source)}.tar.gz`;
  files.set(sourceName, source);
  inventory.push({
    name: "fixture",
    version: "1.0",
    file: sourceName,
    sha256: digest(source),
    usedBy: runtimes.map((item) => item.id),
  });
  files.set("native-artifacts.json", jsonBytes(runtimes));
  files.set("source-inventory.json", jsonBytes(inventory));
  for (const [name, bytes] of files)
    await writeFile(path.join(directory, name), bytes);
  const manifest = {
    schemaVersion: 1,
    repository,
    tag,
    published: false,
    catalogSigned: false,
    runtimeCount: 12,
    producers,
    files: [...files].map(([name, bytes]) => ({
      name,
      size: bytes.length,
      sha256: digest(bytes),
    })),
  };
  const save = async () => {
    const bytes = jsonBytes(manifest);
    const manifestSha256 = digest(bytes);
    await writeFile(path.join(directory, "release-manifest.json"), bytes);
    await writeFile(
      path.join(directory, "SHA256SUMS.txt"),
      [
        ...manifest.files,
        { name: "release-manifest.json", sha256: manifestSha256 },
      ]
        .map((entry) => `${entry.sha256}  ${entry.name}\n`)
        .join(""),
    );
    return { repository, tag, manifestSha256 };
  };
  return {
    root,
    directory,
    files,
    runtimes,
    inventory,
    manifest,
    save,
    options: await save(),
  };
}
