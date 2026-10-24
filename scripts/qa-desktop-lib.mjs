import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { verifyCatalog } from "./catalog-lib.mjs";

export async function verifyQaDesktopPack(offline, platform, arch) {
  if (
    !["macos", "linux"].includes(platform) ||
    !["x64", "arm64"].includes(arch)
  )
    throw new Error("Unsupported desktop QA target");
  const catalog = await verifyCatalog(offline);
  const provenance = JSON.parse(
    await readFile(path.join(offline, "provenance.json"), "utf8"),
  );
  if (provenance.developmentKey !== true)
    throw new Error(
      "Desktop QA requires an explicitly marked development catalog",
    );
  const artifacts = catalog.artifacts.filter(
    (a) => a.platform === platform && a.arch === arch,
  );
  for (const [component, branch] of [
    ["node", "22."],
    ["node", "24."],
    ["php", "8.4."],
    ["php", "8.5."],
    ...[
      "caddy",
      "composer",
      "pnpm",
      "yarn",
      "cacert",
      "mariadb",
      "postgres",
    ].map((c) => [c, ""]),
  ]) {
    if (
      !artifacts.some(
        (a) => a.component === component && a.version.startsWith(branch),
      )
    )
      throw new Error(
        `Incomplete desktop QA stack: ${component} ${branch} ${platform}/${arch}`,
      );
  }
  for (const artifact of artifacts) {
    const file = path.join(offline, artifact.sha256);
    const info = await stat(file);
    if (!info.isFile() || (artifact.size && info.size !== artifact.size))
      throw new Error(`QA archive size mismatch: ${artifact.id}`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (hash.digest("hex") !== artifact.sha256)
      throw new Error(`QA archive checksum mismatch: ${artifact.id}`);
  }
  return catalog;
}
