import {
  readFile,
  writeFile,
  mkdir,
  cp,
  copyFile,
  readdir,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { root, sha256 } from "./catalog-lib.mjs";
import { verifyQaDesktopPack } from "./qa-desktop-lib.mjs";

if (process.env.GITHUB_ACTIONS !== "true" || !process.env.STACKCABIN_QA_KIT_DIR)
  throw new Error("Package desktop QA only in its ephemeral CI checkout");
const platform = process.platform === "darwin" ? "macos" : "linux";
const arch = process.arch;
const kit = process.env.STACKCABIN_QA_KIT_DIR;
const offline = path.join(kit, "offline");
await verifyQaDesktopPack(offline, platform, arch);
const name = `desktop-qa-${platform}-${arch}`;
const output = path.join(root, "artifacts", name);
await mkdir(output);
await cp(offline, path.join(output, "offline"), { recursive: true });
for (const format of platform === "macos" ? ["dmg"] : ["deb", "appimage"]) {
  const source = path.join(root, "target/release/bundle", format);
  const destination = path.join(output, "installers", format);
  await mkdir(destination, { recursive: true });
  for (const file of await readdir(source, { withFileTypes: true }))
    if (file.isFile() && /\.(deb|dmg|AppImage)$/.test(file.name))
      await copyFile(
        path.join(source, file.name),
        path.join(destination, file.name),
      );
}
// Copy only distributed files, excluding Tauri's staging folders.
await copyFile(
  path.join(root, "target/release/bundle/SHA256SUMS.txt"),
  path.join(output, "installers/SHA256SUMS.txt"),
);
for (const [source, destination] of [
  [path.join(root, "docs/QA_DESKTOP.md"), "README.md"],
  [path.join(root, "LICENSE"), "LICENSE"],
  [
    path.join(root, "resources/THIRD_PARTY_NOTICES.txt"),
    "THIRD_PARTY_NOTICES.txt",
  ],
  [path.join(kit, "SOURCE_COMMIT.txt"), "RUNTIME_KIT_SOURCE_COMMIT.txt"],
  [path.join(kit, "NATIVE_SOURCES.txt"), "NATIVE_SOURCES.txt"],
])
  await copyFile(source, path.join(output, destination));
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
await writeFile(path.join(output, "SOURCE_COMMIT.txt"), commit + "\n");
await writeFile(
  path.join(output, "CATALOG_SHA256.txt"),
  sha256(await readFile(path.join(offline, "catalog.json"))) + "\n",
);
const archive = path.join(root, "artifacts", name + ".tar.gz");
execFileSync("tar", ["-czf", archive, "-C", output, "."], { stdio: "inherit" });
await writeFile(
  archive + ".sha256",
  `${sha256(await readFile(archive))}  ${name}.tar.gz\n`,
);
console.log(
  `Packaged StackCabin QA installers with matching offline archives for ${platform}/${arch}`,
);
