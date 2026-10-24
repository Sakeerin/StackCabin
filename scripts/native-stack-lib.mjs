import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

// Verify all downloaded native bytes before signing the combined CI-only catalog.
export async function verifyNativeStack(
  folder,
  platform,
  arch,
  builds,
  sources,
) {
  const verified = [];
  const seen = new Set();
  for (const build of builds) {
    const { component, version } = build;
    if (
      !["php", "mariadb", "postgres"].includes(component) ||
      !/^\d+\.\d+(?:\.\d+)?$/.test(version) ||
      !["linux", "macos"].includes(platform) ||
      !["arm64", "x64"].includes(arch)
    )
      throw new Error("Invalid native stack selection");
    const id = `${component}-${version}-${platform}-${arch}`;
    if (seen.has(id)) throw new Error("Duplicate native stack selection");
    seen.add(id);
    const metadata = JSON.parse(
      await readFile(path.join(folder, id + ".json"), "utf8"),
    );
    const source = sources.find(
      (s) => s.component === component && s.version === version,
    );
    const minimum = String(metadata.minimumOsVersion || "");
    const [major, minor = 0, patch = 0] = minimum.split(".").map(Number);
    const supportedMac =
      /^\d+\.\d+(?:\.\d+)?$/.test(minimum) &&
      (major < 14 || (major === 14 && minor === 0 && patch === 0));
    if (
      !source ||
      metadata.id !== id ||
      metadata.component !== component ||
      metadata.version !== version ||
      metadata.platform !== platform ||
      metadata.arch !== arch ||
      metadata.sourceUrl !== source.sourceUrl ||
      metadata.archive !== "tar.gz" ||
      !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
      (platform === "macos" && !supportedMac)
    )
      throw new Error(
        `Native metadata does not match reviewed selection: ${id}`,
      );
    const archive = path.join(folder, id + ".tar.gz");
    if ((await stat(archive)).size !== metadata.size)
      throw new Error(`Native archive size mismatch: ${id}`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    if (hash.digest("hex") !== metadata.sha256)
      throw new Error(`Native archive checksum mismatch: ${id}`);
    verified.push(metadata);
  }
  return verified;
}
