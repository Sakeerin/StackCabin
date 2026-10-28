// Read-only installer checks. Every subprocess uses -CheckOnly; no runtime is installed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

if (process.platform !== "win32") throw new Error("Run these prerequisite checks on Windows");
const root = fileURLToPath(new URL("../", import.meta.url));
const parent = path.join(root, ".local", "prerequisite-tests");
mkdirSync(parent, { recursive: true });
const fixture = mkdtempSync(path.join(parent, "case-"));
after(() => rmSync(fixture, { recursive: true, force: true }));
const specification = JSON.parse(readFileSync(path.join(root, "runtime-catalog/windows-prerequisites.json")));
const payload = path.join(root, "artifacts/windows-prerequisites");
const corrupted = readFileSync(path.join(payload, "vc_redist.x64.exe"));
corrupted[64] ^= 0xff; // Alter an Authenticode-hashed DOS-stub byte, preserving the MZ header.
writeFileSync(path.join(fixture, "vc_redist.x64.exe"), corrupted);
function check(directory, manifest) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", path.join(root, "src-tauri/windows/install-vc-runtime.ps1"),
    "-PayloadDirectory", directory, "-Manifest", manifest, "-CheckOnly"], { encoding: "utf8" });
}
test("a pinned Microsoft-signed payload reports the real installed version without executing it", () => {
  const result = check(payload, path.join(root, "runtime-catalog/windows-prerequisites.json"));
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.payloadVerified, true);
  assert.equal(report.requiredVersion, specification.visualCpp.version);
  assert.equal(typeof report.installationNeeded, "boolean");
});
test("a modified payload fails its pinned checksum", () => {
  const result = check(fixture, path.join(root, "runtime-catalog/windows-prerequisites.json"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum mismatch/);
});
test("updating the hash cannot make a tampered Microsoft binary authentic", () => {
  const manifest = path.join(fixture, "changed-hash.json");
  writeFileSync(manifest, JSON.stringify({ visualCpp: { ...specification.visualCpp,
    sha256: createHash("sha256").update(corrupted).digest("hex") } }));
  const result = check(fixture, manifest);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /valid Microsoft signature/);
});
test("a different payload version cannot be substituted even with a valid signature", () => {
  const manifest = path.join(fixture, "wrong-version.json");
  writeFileSync(manifest, JSON.stringify({ visualCpp: { ...specification.visualCpp, version: "0.0.0.1" } }));
  const result = check(payload, manifest);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /version mismatch/);
});
