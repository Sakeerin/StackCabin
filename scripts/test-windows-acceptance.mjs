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

test("installer upgrade acceptance refuses local and self-hosted machines", async () => {
  const kit = await fixture();
  for (const environment of [
    { GITHUB_ACTIONS: "false", RUNNER_ENVIRONMENT: "github-hosted" },
    { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" },
  ]) {
    for (const location of ["custom", "default"]) {
      const result = spawnSync(
        powershell,
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(root, "scripts/verify-windows-upgrade.ps1"),
          "-PreviousInstaller",
          path.join(kit, "native-smoke.exe"),
          "-CandidateInstaller",
          path.join(kit, "native-smoke.exe"),
          "-Python",
          process.execPath,
          "-DataLocation",
          location,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, ...environment, RUNNER_OS: "Windows" },
        },
      );
      if (result.error) throw result.error;
      assert.notEqual(result.status, 0);
      assert.match(
        result.stdout + result.stderr,
        /requires a disposable GitHub-hosted Windows runner/,
      );
    }
  }
});

test("offline installation acceptance refuses local, self-hosted and non-Windows machines", async () => {
  for (const environment of [
    {
      GITHUB_ACTIONS: "false",
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_OS: "Windows",
    },
    {
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "self-hosted",
      RUNNER_OS: "Windows",
    },
    {
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_OS: "Linux",
    },
  ]) {
    const result = spawnSync(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(root, "scripts/verify-windows-offline.ps1"),
        "-Bundle",
        "must-not-be-resolved",
        "-Python",
        process.execPath,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, ...environment },
        timeout: 30_000,
      },
    );
    if (result.error) throw result.error;
    assert.notEqual(result.status, 0);
    assert.match(
      result.stdout + result.stderr,
      /requires a disposable GitHub-hosted Windows runner/,
    );
  }
});

test("standard-user acceptance retains identity and round-trips literal Windows arguments", async () => {
  const kit = await fixture();
  const argumentsFile = path.join(kit, "arguments.json");
  const values = [
    "",
    "พาธ ที่มีช่องว่าง\\",
    'literal "quote"',
    'backslash\\"quote',
    "$(literal); & value",
  ];
  await writeFile(argumentsFile, JSON.stringify(values));
  const script = path.join(kit, "check-launcher.ps1");
  await writeFile(
    script,
    `param($Launcher, $Node, $ArgumentsFile)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -Path $Launcher
[StackCabinAcceptance.StandardUser]::VerifyIdentity()
$values = Get-Content -LiteralPath $ArgumentsFile -Raw -Encoding utf8 | ConvertFrom-Json
$arguments = @('-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))') + $values
$quoted = @($arguments | ForEach-Object { [StackCabinAcceptance.StandardUser]::Quote($_) }) -join ' '
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $Node
$start.Arguments = $quoted
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$child = [System.Diagnostics.Process]::Start($start)
$output = $child.StandardOutput.ReadToEnd()
$diagnostic = $child.StandardError.ReadToEnd()
$child.WaitForExit()
if ($child.ExitCode -ne 0) { throw $diagnostic }
[Console]::Write($output)
`,
  );
  const result = spawnSync(
    powershell,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-Launcher",
      path.join(root, "scripts/StandardUserAcceptance.cs"),
      "-Node",
      process.execPath,
      "-ArgumentsFile",
      argumentsFile,
    ],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), values);
});
