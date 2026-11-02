import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = (name) =>
  readFileSync(new URL(`../workflows/${name}.yml`, import.meta.url), "utf8");

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
