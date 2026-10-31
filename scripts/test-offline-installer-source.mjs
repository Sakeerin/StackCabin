import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogFiles } from "./windows-offline-manifest.mjs";
import {
  compareCatalogFiles,
  verifyInstallerRun,
  verifyPackagingChanges,
} from "./verify-offline-installer-source.mjs";

const repository = "Sakeerin/StackCabin";
function run() {
  return {
    id: 123,
    status: "completed",
    conclusion: "success",
    event: "workflow_dispatch",
    path: ".github/workflows/preview-installers.yml",
    head_sha: "a".repeat(40),
    repository: { full_name: repository },
    head_repository: { full_name: repository },
  };
}
test("accepts a successful normal installer run from the requested repository", () => {
  assert.equal(
    verifyInstallerRun(run(), repository.toLowerCase(), "123"),
    "a".repeat(40),
  );
});
test("rejects pending, failed and cancelled installer builds", () => {
  for (const values of [
    { status: "in_progress" },
    { conclusion: "failure" },
    { conclusion: "cancelled" },
  ])
    assert.throws(
      () => verifyInstallerRun({ ...run(), ...values }, repository, "123"),
      /successfully completed/,
    );
});
test("rejects other workflows and unrequested execution events", () => {
  for (const values of [
    { path: ".github/workflows/qa-desktop.yml" },
    { event: "pull_request" },
  ])
    assert.throws(
      () => verifyInstallerRun({ ...run(), ...values }, repository, "123"),
      /normal development installer/,
    );
});
test("rejects forks, foreign repositories and missing repository identities", () => {
  for (const key of ["repository", "head_repository"])
    for (const identity of [{ full_name: "another/StackCabin" }, null])
      assert.throws(
        () =>
          verifyInstallerRun({ ...run(), [key]: identity }, repository, "123"),
        /this repository/,
      );
});
test("rejects mismatched run IDs and malformed source commits", () => {
  for (const id of ["124", "123;anything", "00123"])
    assert.throws(() => verifyInstallerRun(run(), repository, id), /run ID/);
  for (const head_sha of ["", "--help", "a".repeat(39), "A".repeat(40)])
    assert.throws(
      () => verifyInstallerRun({ ...run(), head_sha }, repository, "123"),
      /source commit/,
    );
});
test("permits reviewed packaging, test and documentation changes when reusing an installer", () => {
  verifyPackagingChanges([
    "README.md",
    "docs/QUICKSTART.th.md",
    ".github/workflows/windows-offline-bundle.yml",
    "scripts/Install-StackCabin.ps1",
    "scripts/windows-offline-bundle.ps1",
    "scripts/windows-offline-manifest.mjs",
    "scripts/verify-offline-installer-source.mjs",
    "scripts/verify-windows-offline.ps1",
    "scripts/offline-pack.mjs",
    "scripts/test-windows-offline-bundle.mjs",
  ]);
});
test("requires a fresh installer for changed app inputs, even with the same version", () => {
  for (const file of [
    "src/App.tsx",
    "crates/core/src/lib.rs",
    "src-tauri/tauri.conf.json",
    "Cargo.lock",
    "package.json",
    "package-lock.json",
    "resources/THIRD_PARTY_NOTICES.txt",
    "scripts/prepare-windows-prerequisites.ps1",
    "runtime-catalog/catalog.json",
    "scripts/test-fixtures/build.js",
  ])
    assert.throws(
      () => verifyPackagingChanges([file]),
      /Application inputs changed/,
    );
});
test("compares exact catalog, signature, trust root, provenance and prerequisite bytes", () => {
  const files = [
    ...catalogFiles.map((file) => `runtime-catalog/${file}`),
    "runtime-catalog/windows-prerequisites.json",
  ];
  const original = Object.fromEntries(
    files.map((file) => [file, Buffer.from(file)]),
  );
  const hashes = compareCatalogFiles(original, { ...original });
  assert.equal(Object.keys(hashes).length, files.length);
  for (const file of files) {
    assert.throws(
      () =>
        compareCatalogFiles(original, {
          ...original,
          [file]: Buffer.from("changed"),
        }),
      /mismatch/,
    );
    assert.throws(
      () => compareCatalogFiles(original, { ...original, [file]: undefined }),
      /mismatch/,
    );
  }
});
