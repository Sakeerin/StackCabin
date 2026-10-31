// Fixtures contain no executable installers. Windows checks must stop before the helper.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { root, sha256 } from "./catalog-lib.mjs";
import {
  bundleFiles,
  catalogFiles,
  verifyRuntimePack,
} from "./windows-offline-manifest.mjs";

const fixtures = [];
after(async () => {
  for (const directory of fixtures)
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "stackcabin-offline-"),
  );
  fixtures.push(directory);
  const pack = path.join(directory, "bundle space ทดสอบ");
  const trusted = path.join(directory, "trusted");
  await mkdir(pack);
  await mkdir(trusted);
  await mkdir(path.join(pack, "prerequisites"));
  const archive = Buffer.from("A pinned runtime archive fixture");
  const digest = sha256(archive);
  const artifact = {
    id: "node-test-windows-x64",
    platform: "windows",
    arch: "x64",
    sha256: digest,
    url: "https://example.test/node.zip",
  };
  const catalog = Buffer.from(
    JSON.stringify({ schemaVersion: 1, artifacts: [artifact] }),
  );
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const values = {
    "catalog.json": catalog,
    "catalog.sig": sign(null, catalog, privateKey).toString("base64") + "\n",
    "public-key.txt":
      publicKey
        .export({ type: "spki", format: "der" })
        .subarray(-32)
        .toString("base64") + "\n",
    "provenance.json": JSON.stringify({ developmentKey: true }),
  };
  for (const file of catalogFiles) {
    await writeFile(path.join(trusted, file), values[file]);
    await writeFile(path.join(pack, file), values[file]);
  }
  for (const file of bundleFiles.filter(
    (file) => !catalogFiles.includes(file),
  )) {
    await writeFile(path.join(pack, file), `Fixture only: ${file}`);
  }
  await copyFile(
    path.join(root, "scripts/Install-StackCabin.ps1"),
    path.join(pack, "Install-StackCabin.ps1"),
  );
  await writeFile(
    path.join(pack, "prerequisites/install-vc-runtime.ps1"),
    "Set-Content -LiteralPath (Join-Path $PSScriptRoot '../helper-was-executed') -Value 'unexpected'\nexit 42\n",
  );
  await writeFile(path.join(pack, digest), archive);
  const manifest = {
    schemaVersion: 1,
    platform: "windows",
    arch: "x64",
    appVersion: "0.1.0",
    files: [],
  };
  for (const file of [...bundleFiles, digest]) {
    const bytes = await readFile(path.join(pack, file));
    manifest.files.push({ file, sha256: sha256(bytes), bytes: bytes.length });
  }
  await save(pack, manifest);
  return { pack, trusted, manifest, digest };
}
async function save(pack, manifest) {
  await writeFile(
    path.join(pack, "installer-manifest.json"),
    JSON.stringify(manifest),
  );
}
async function rejected(pack, expected, checkOnly = true) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(pack, "Install-StackCabin.ps1"),
      ...(checkOnly ? ["-CheckOnly"] : []),
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (result.error) throw result.error;
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, expected);
  await assert.rejects(readFile(path.join(pack, "helper-was-executed")), {
    code: "ENOENT",
  });
}

test("builder verifies a catalog against its trusted source and hashes its archives", async () => {
  const { pack, trusted, digest } = await fixture();
  const result = await verifyRuntimePack(pack, trusted);
  assert.equal(result.runtimeCount, 1);
  assert.equal(result.archives[0].sha256, digest);
});
test("builder refuses a different pack key even when its catalog has a valid signature", async () => {
  const a = await fixture();
  const b = await fixture();
  await assert.rejects(
    verifyRuntimePack(a.pack, b.trusted),
    /does not match.*catalog.sig/,
  );
});
test("builder rejects a tampered trusted catalog signature", async () => {
  const { pack, trusted } = await fixture();
  await writeFile(
    path.join(trusted, "catalog.sig"),
    Buffer.alloc(64).toString("base64"),
  );
  await assert.rejects(
    verifyRuntimePack(pack, trusted),
    /Invalid catalog signature/,
  );
});
test("builder rejects corrupt and missing runtime archives", async () => {
  const { pack, trusted, digest } = await fixture();
  await writeFile(path.join(pack, digest), "corrupted");
  await assert.rejects(
    verifyRuntimePack(pack, trusted),
    /Runtime checksum mismatch/,
  );
  await rm(path.join(pack, digest));
  await assert.rejects(verifyRuntimePack(pack, trusted), { code: "ENOENT" });
});
test("builder refuses linked bundle directories", async () => {
  const { pack, trusted } = await fixture();
  const link = path.join(path.dirname(pack), "linked-pack");
  await symlink(pack, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(verifyRuntimePack(link, trusted), /must not be a link/);
});

const windows = process.platform === "win32" ? test : test.skip;
for (const checkOnly of [true, false]) {
  windows(
    `Windows ${checkOnly ? "CheckOnly" : "install"} preflight rejects a truncated archive before executing helpers`,
    async () => {
      const { pack, digest } = await fixture();
      await writeFile(path.join(pack, digest), "truncated");
      await rejected(pack, /Bundle checksum mismatch/, checkOnly);
    },
  );
}
windows("Windows preflight rejects changed helpers and catalogs", async () => {
  for (const file of ["prerequisites/install-vc-runtime.ps1", "catalog.json"]) {
    const { pack } = await fixture();
    await writeFile(path.join(pack, file), "changed");
    await rejected(pack, /Bundle checksum mismatch/);
  }
});
windows(
  "Windows preflight rejects duplicate manifest paths including case variants",
  async () => {
    const { pack, manifest } = await fixture();
    manifest.files.push({ ...manifest.files[0], file: "CATALOG.JSON" });
    await save(pack, manifest);
    await rejected(pack, /Duplicate bundle manifest entry/);
  },
);
windows("Windows preflight rejects traversal paths", async () => {
  const { pack, manifest } = await fixture();
  manifest.files.unshift({
    file: "../outside.exe",
    sha256: "0".repeat(64),
    bytes: 1,
  });
  await save(pack, manifest);
  await rejected(pack, /Invalid bundle path/);
});
windows("Windows preflight rejects missing helper entries", async () => {
  const { pack, manifest } = await fixture();
  manifest.files = manifest.files.filter(
    (entry) => entry.file !== "prerequisites/install-vc-runtime.ps1",
  );
  await save(pack, manifest);
  await rejected(pack, /Missing bundle manifest entry/);
});
windows(
  "Windows preflight rejects missing archives even when their manifest entry is removed",
  async () => {
    const { pack, manifest, digest } = await fixture();
    manifest.files = manifest.files.filter((entry) => entry.file !== digest);
    await rm(path.join(pack, digest));
    await save(pack, manifest);
    await rejected(pack, /Missing or mismatched runtime archive/);
  },
);
windows(
  "Windows preflight rejects archive substitutions with rewritten hashes",
  async () => {
    const { pack, manifest, digest } = await fixture();
    const bytes = Buffer.from("substituted archive");
    await writeFile(path.join(pack, digest), bytes);
    Object.assign(
      manifest.files.find((entry) => entry.file === digest),
      { sha256: sha256(bytes), bytes: bytes.length },
    );
    await save(pack, manifest);
    await rejected(pack, /Missing or mismatched runtime archive/);
  },
);
windows(
  "Windows preflight rejects malformed integrity metadata and unsupported manifests",
  async () => {
    for (const mutation of [
      (m) => {
        m.files[0].sha256 = "invalid";
      },
      (m) => {
        m.files[0].bytes = "1";
      },
      (m) => {
        m.files[0].bytes = true;
      },
      (m) => {
        m.schemaVersion = 2;
      },
    ]) {
      const { pack, manifest } = await fixture();
      mutation(manifest);
      await save(pack, manifest);
      await rejected(
        pack,
        /Invalid bundle integrity metadata|Unsupported offline bundle manifest/,
      );
    }
  },
);
windows("Windows preflight rejects extra manifest payloads", async () => {
  const { pack, manifest } = await fixture();
  const bytes = Buffer.from("not part of this bundle");
  await writeFile(path.join(pack, "extra.exe"), bytes);
  manifest.files.push({
    file: "extra.exe",
    sha256: sha256(bytes),
    bytes: bytes.length,
  });
  await save(pack, manifest);
  await rejected(pack, /Unexpected bundle manifest entry/);
});
windows(
  "builder rejects an installer with the wrong expected checksum before refreshing a bundle",
  async () => {
    const { pack } = await fixture();
    const checkout = path.dirname(pack);
    await mkdir(path.join(checkout, "scripts"));
    const builder = path.join(checkout, "scripts/windows-offline-bundle.ps1");
    await copyFile(
      path.join(root, "scripts/windows-offline-bundle.ps1"),
      builder,
    );
    await writeFile(
      path.join(checkout, "package.json"),
      JSON.stringify({ version: "0.1.0" }),
    );
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        builder,
        "-Installer",
        path.join(pack, "StackCabin-setup.exe"),
        "-InstallerSha256",
        "0".repeat(64),
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    if (result.error) throw result.error;
    assert.notEqual(result.status, 0);
    assert.match(
      result.stdout + result.stderr,
      /Source installer checksum mismatch/,
    );
  },
);
windows("Windows preflight rejects linked prerequisite folders", async () => {
  const { pack } = await fixture();
  const original = path.join(path.dirname(pack), "original-prerequisites");
  await mkdir(original);
  await rm(path.join(pack, "prerequisites"), { recursive: true });
  await symlink(original, path.join(pack, "prerequisites"), "junction");
  await rejected(pack, /Bundle links are not supported/);
});
windows(
  "Windows preflight rejects unsigned WebView2 payloads before running the VC helper",
  async () => {
    const { pack } = await fixture();
    await rejected(
      pack,
      /WebView2 prerequisite has no valid Microsoft signature/,
    );
  },
);
