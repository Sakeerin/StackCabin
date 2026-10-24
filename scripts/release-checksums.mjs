import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { root } from "./catalog-lib.mjs";

const directory = path.join(root, "target", "release", "bundle");
async function find(folder) {
  const files = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) files.push(...(await find(full)));
    else if (entry.isFile() && /^(?:nsis\/[^/]+\.exe|dmg\/[^/]+\.dmg|deb\/[^/]+\.deb|appimage\/[^/]+\.AppImage)$/i.test(path.relative(directory, full).replaceAll("\\", "/")))
      files.push(full);
  }
  return files;
}
const files = (await find(directory)).sort();
if (!files.length)
  throw new Error("Build an installer before generating release checksums");
const lines = [];
for (const file of files) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  lines.push(
    `${hash.digest("hex")}  ${path.relative(directory, file).replaceAll("\\", "/")}`,
  );
}
const contents = lines.join("\n") + "\n";
await mkdir(path.join(root, "artifacts"), { recursive: true });
await writeFile(path.join(directory, "SHA256SUMS.txt"), contents);
await writeFile(path.join(root, "artifacts", "SHA256SUMS.txt"), contents);
console.log(contents.trim());
