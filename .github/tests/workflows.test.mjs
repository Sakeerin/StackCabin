import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const workflow = (name) =>
  readFileSync(new URL(`../workflows/${name}.yml`, import.meta.url), "utf8");

test("native release preparation uses reviewed producers and has no publishing or signing permission", () => {
  const prepare = workflow("prepare-native-release");
  assert.match(prepare, /contents: read/);
  assert.match(prepare, /actions: read/);
  assert.doesNotMatch(
    prepare,
    /contents: write|secrets\.|gh release|--clobber/,
  );
  assert.match(prepare, /native-test-builds\.json/);
  assert.match(prepare, /verifyProducer\(run, build, repository\)/);
  assert.match(prepare, /!a\.expired/);
  assert.match(prepare, /sha256sum --check SHA256SUMS\.txt/);
  assert.match(prepare, /if-no-files-found: error/);
});

// These workflows use the common JavaScript-compatible subset of Actions
// expressions. actionlint independently checks the actual Actions syntax/types.
function evaluate(expression, inputs) {
  return Function(
    "inputs",
    "startsWith",
    "fromJSON",
    `"use strict"; return (${expression});`,
  )(inputs, (value, prefix) => value.startsWith(prefix), JSON.parse);
}

function matrix(name, target) {
  const expression = workflow(name).match(/include: \$\{\{ (.+) \}\}/)?.[1];
  assert.ok(expression, `Missing matrix in ${name}`);
  return evaluate(expression, { target });
}

function installerArtifact(name, inputs) {
  const entry = workflow(name).match(
    /name: (development-installers-|desktop-qa-)\$\{\{ (.+) \}\}/,
  );
  assert.ok(entry, `Missing artifact selector in ${name}`);
  return entry[1] + evaluate(entry[2], inputs);
}

test("artifact consumers require explicit producer runs instead of expiring defaults", () => {
  for (const [name, input] of [
    ["windows-offline-bundle", "installer_run"],
    ["verify-windows-upgrade", "source_run"],
    ["qa-desktop", "source_run"],
    ["verify-preview-upgrade", "source_run"],
    ["verify-preview-installer", "source_run"],
    ["verify-qa-desktop", "source_run"],
    ["verify-unix-qa", "source_run"],
  ]) {
    const section = workflow(name).match(
      new RegExp(
        `^      ${input}:\\r?\\n([\\s\\S]*?)(?=^      \\w+:|^permissions:)`,
        "m",
      ),
    )?.[1];
    assert.ok(section, `${name}/${input}`);
    assert.match(section, /required: true/, `${name}/${input}`);
    assert.doesNotMatch(section, /default:/, `${name}/${input}`);
  }
  const coexistence = workflow("verify-qa-desktop");
  assert.doesNotMatch(coexistence, /default: ["']?\d/);
  assert.match(
    coexistence,
    /NORMAL_INSTALLER_RUN: \$\{\{ inputs.normal_installer_run \}\}/,
  );
  assert.match(
    coexistence,
    /Linux coexistence requires a successful normal_installer_run/,
  );
});

test("reviewed native selections stay outside desktop resources and reach every QA consumer", () => {
  const selections = JSON.parse(
    readFileSync(
      new URL("../native-test-builds.json", import.meta.url),
      "utf8",
    ),
  );
  const { sources } = JSON.parse(
    readFileSync(
      new URL("../../runtime-catalog/source-archives.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    existsSync(
      new URL("../../runtime-catalog/native-test-builds.json", import.meta.url),
    ),
    false,
  );
  for (const [target, runner] of Object.entries({
    "linux-x64": "ubuntu-22.04",
    "macos-arm64": "macos-15",
    "macos-x64": "macos-15-intel",
  })) {
    const builds = selections.targets[target];
    assert.deepEqual(
      builds.map(({ component, version }) => `${component}-${version}`).sort(),
      sources.map(({ component, version }) => `${component}-${version}`).sort(),
    );
    for (const { component, version, run, artifact } of builds) {
      assert.match(run, /^[1-9]\d*$/);
      assert.equal(artifact, `${component}-${version}-${runner}`);
    }
  }
  for (const file of [
    ".github/workflows/verify-native-stack.yml",
    "scripts/prepare-native-stack.mjs",
    "scripts/package-native-qa.mjs",
  ]) {
    const content = readFileSync(
      new URL(`../../${file}`, import.meta.url),
      "utf8",
    );
    assert.ok(content.includes(".github/native-test-builds.json"), file);
    assert.ok(
      !content.includes("runtime-catalog/native-test-builds.json"),
      file,
    );
  }
});

test("combined stack retains Linux, native ARM/Intel and x64 compatibility coverage", () => {
  const all = matrix("verify-native-stack", "all");
  assert.deepEqual(
    all.map(({ os, arch }) => `${os}/${arch}`).sort(),
    [
      "ubuntu-22.04/x64",
      "ubuntu-24.04/x64",
      "macos-15/arm64",
      "macos-15/x64",
      "macos-15-intel/x64",
    ].sort(),
  );
  for (const [target, count] of [
    ["linux", 2],
    ["linux-baseline", 1],
    ["macos-arm64", 1],
    ["macos-x64", 2],
  ]) {
    const selected = matrix("verify-native-stack", target);
    assert.equal(selected.length, count);
    for (const entry of selected)
      assert.ok(
        all.some((row) => row.os === entry.os && row.arch === entry.arch),
      );
  }
});

test("QA desktop consumes only kits produced for its actual runner and architecture", () => {
  assert.match(
    workflow("verify-native-stack"),
    /name: native-qa-\$\{\{ matrix.os \}\}-\$\{\{ matrix.arch \}\}/,
  );
  const kits = matrix("verify-native-stack", "all").map(
    ({ os, arch }) => `native-qa-${os}-${arch}`,
  );
  const desktop = matrix("qa-desktop", "all");
  assert.equal(desktop.length, 3);
  for (const { os, artifact } of desktop) {
    assert.ok(kits.includes(artifact), `No producer for ${artifact}`);
    const arch = os === "macos-15" ? "arm64" : "x64";
    assert.equal(artifact, `native-qa-${os}-${arch}`);
  }
});

test("QA upgrades consume the corresponding desktop producer on every target", () => {
  assert.match(
    workflow("qa-desktop"),
    /name: desktop-qa-\$\{\{ matrix.os \}\}/,
  );
  const producers = matrix("qa-desktop", "all").map(
    ({ os }) => `desktop-qa-${os}`,
  );
  const upgrades = matrix("verify-preview-upgrade", "all");
  assert.equal(upgrades.length, 3);
  for (const { os, artifact } of upgrades) {
    assert.ok(producers.includes(artifact));
    assert.equal(artifact, `desktop-qa-${os}`);
  }
  for (const [target, os] of [
    ["linux", "ubuntu-22.04"],
    ["macos-arm64", "macos-15"],
    ["macos-x64", "macos-15-intel"],
  ]) {
    assert.equal(matrix("qa-desktop", target)[0].os, os);
    assert.equal(matrix("verify-preview-upgrade", target)[0].os, os);
    assert.deepEqual(matrix("qa-desktop", target), [
      matrix("qa-desktop", "all").find(
        (row) => row.os === matrix("verify-preview-upgrade", target)[0].os,
      ),
    ]);
    assert.equal(matrix("verify-preview-upgrade", target).length, 1);
  }
});

test("native Intel installer checks cannot select ARM artifacts from the default input", () => {
  for (const [name, prefix] of [
    ["verify-preview-installer", "development-installers-"],
    ["verify-qa-desktop", "desktop-qa-"],
  ]) {
    for (const arch of ["arm64", "x64"]) {
      assert.equal(
        installerArtifact(name, { runner: "macos-15-intel", arch }),
        `${prefix}macos-15-intel`,
      );
    }
    assert.equal(
      installerArtifact(name, { runner: "macos-15", arch: "arm64" }),
      `${prefix}macos-15`,
    );
    assert.equal(
      installerArtifact(name, { runner: "macos-15", arch: "x64" }),
      `${prefix}macos-15-intel`,
    );
    assert.equal(
      installerArtifact(name, { runner: "ubuntu-24.04", arch: "arm64" }),
      `${prefix}ubuntu-22.04`,
    );
  }
  assert.equal(
    installerArtifact("verify-preview-installer", {
      runner: "windows-latest",
      arch: "arm64",
    }),
    "development-installers-windows-latest",
  );
});
