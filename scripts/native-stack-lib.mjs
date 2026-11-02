import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

async function fileSha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

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
      !/^[a-f0-9]{64}$/.test(source.sourceSha256 || "") ||
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
    const provenance = JSON.parse(
      await readFile(path.join(folder, id + "-provenance.json"), "utf8"),
    );
    if (
      provenance.sourceUrl !== source.sourceUrl ||
      provenance.sourceSha256 !== source.sourceSha256 ||
      provenance.verification?.component !== component ||
      provenance.verification?.version !== version ||
      provenance.verification?.result !== "passed" ||
      (platform === "macos" &&
        provenance.minimumOsVersion !== metadata.minimumOsVersion)
    )
      throw new Error(
        `Native provenance does not match reviewed selection: ${id}`,
      );
    if (
      (await fileSha256(path.join(folder, id + "-source.tar.gz"))) !==
      source.sourceSha256
    )
      throw new Error(`Native source archive checksum mismatch: ${id}`);
    const archive = path.join(folder, id + ".tar.gz");
    if ((await stat(archive)).size !== metadata.size)
      throw new Error(`Native archive size mismatch: ${id}`);
    if ((await fileSha256(archive)) !== metadata.sha256)
      throw new Error(`Native archive checksum mismatch: ${id}`);
    verified.push(metadata);
  }
  return verified;
}
