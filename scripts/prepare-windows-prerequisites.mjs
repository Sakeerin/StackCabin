import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  const target = process.env.TAURI_ENV_ARCH || process.arch;
  if (!["x64", "x86_64"].includes(target)) throw new Error(`Windows prerequisite payloads are not certified for ${target}`);
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", fileURLToPath(new URL("prepare-windows-prerequisites.ps1", import.meta.url))], { stdio: "inherit" });
}
