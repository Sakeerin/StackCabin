import { verifyCatalog, root, get, sha256 } from "./catalog-lib.mjs";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
const platform = process.argv
  .find((a) => a.startsWith("--platform="))
  ?.slice(11);
const arch =
  process.argv.find((a) => a.startsWith("--arch="))?.slice(7) || "x64";
if (!["windows", "macos", "linux"].includes(platform))
  throw new Error("Pass --platform=windows|macos|linux [--arch=x64|arm64]");
const catalog = await verifyCatalog(undefined, !process.argv.includes("--dev"));
const output = path.join(root, "artifacts", `offline-${platform}-${arch}`);
const cache =
  process.argv.find((a) => a.startsWith("--cache="))?.slice(8) ||
  path.join(root, ".local", "publisher-cache");
await mkdir(output, { recursive: true });
for (const file of [
  "catalog.json",
  "catalog.sig",
  "public-key.txt",
  "provenance.json",
])
  await copyFile(
    path.join(root, "runtime-catalog", file),
    path.join(output, file),
  );
for (const artifact of catalog.artifacts.filter(
  (a) => a.platform === platform && a.arch === arch,
)) {
  const file = path.join(output, artifact.sha256);
  let bytes;
  try {
    bytes = await readFile(file);
  } catch {
    try {
      bytes = await readFile(path.join(cache, sha256(artifact.url)));
    } catch {
      bytes = await get(artifact.url, true);
    }
  }
  if (sha256(bytes) !== artifact.sha256)
    throw new Error(`Checksum mismatch: ${artifact.id}`);
  await writeFile(file, bytes);
  console.log(`Packed ${artifact.id}`);
}
await writeFile(
  path.join(output, "README.txt"),
  "StackCabin offline runtime pack\nChoose this folder in Runtimes > Install from offline pack.\nUse with the StackCabin application release that contains this catalog and public key.\nFramework dependencies are not included.\n" +
    (process.argv.includes("--dev")
      ? "DEVELOPMENT BUILD: requires clean-machine certification before public release.\n"
      : ""),
);
console.log(output);
