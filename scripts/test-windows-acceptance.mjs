import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  writeFile,
  copyFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { root, sha256 } from "./catalog-lib.mjs";

if (process.platform !== "win32")
  throw new Error("Windows-only acceptance wrapper checks");
const powershell = path.join(
  process.env.SystemRoot,
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
const fixtures = [];
after(async () => {
  for (const directory of fixtures) {
    await rm(directory, { recursive: true, force: true });
  }
});
async function fixture() {
  const kit = path.join(root, ".local/windows-acceptance-tests", randomUUID());
  await mkdir(kit, { recursive: true });
  fixtures.push(kit);
  const bytes = Buffer.from("Fixture only; must never be executed");
  await writeFile(path.join(kit, "native-smoke.exe"), bytes);
  await writeFile(
    path.join(kit, "SHA256SUMS.txt"),
    `${sha256(bytes)}  native-smoke.exe\n`,
  );
  await copyFile(
    path.join(root, "scripts/Invoke-StackCabinAcceptance.ps1"),
    path.join(kit, "Invoke-StackCabinAcceptance.ps1"),
  );
  return kit;
}
function rejected(kit, workspace, expected) {
  const result = spawnSync(
    powershell,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(kit, "Invoke-StackCabinAcceptance.ps1"),
      "-Workspace",
      workspace,
    ],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, expected);
}
test("refuses changed acceptance binaries before creating a workspace", async () => {
  const kit = await fixture();
  await writeFile(path.join(kit, "native-smoke.exe"), "corrupted");
  const workspace = path.join(kit, "new workspace ทดสอบ");
  rejected(kit, workspace, /checksum mismatch/);
  await assert.rejects(readFile(path.join(workspace, "acceptance.log")), {
    code: "ENOENT",
  });
});
test("preserves existing hidden workspace data", async () => {
  const kit = await fixture();
  const workspace = path.join(kit, "existing ทดสอบ");
  await mkdir(workspace);
  const existing = path.join(workspace, ".keep");
  await writeFile(existing, "keep my data");
  rejected(kit, workspace, /new or empty/);
  assert.equal(await readFile(existing, "utf8"), "keep my data");
});
test("rejects malformed checksum manifests", async () => {
  const kit = await fixture();
  await writeFile(path.join(kit, "SHA256SUMS.txt"), "invalid\n");
  rejected(kit, path.join(kit, "new"), /Invalid acceptance binary checksum/);
});
test("rejects junction workspaces without touching the target", async () => {
  const kit = await fixture();
  const target = path.join(kit, "original");
  await mkdir(target);
  const link = path.join(kit, "junction");
  await symlink(target, link, "junction");
  rejected(kit, link, /not a file, junction or symbolic link/);
  await assert.rejects(readFile(path.join(target, "acceptance.log")), {
    code: "ENOENT",
  });
});
test("rejects file workspaces without replacing their contents", async () => {
  const kit = await fixture();
  const target = path.join(kit, "original.txt");
  await writeFile(target, "keep my data");
  rejected(kit, target, /not a file, junction or symbolic link/);
  assert.equal(await readFile(target, "utf8"), "keep my data");
});
