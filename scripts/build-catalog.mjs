// Build metadata from publisher HTTPS endpoints, then sign the exact bytes.
// Publisher checksums are used where provided; downloaded assets are hashed before registration.
import {
  get,
  root,
  sha256,
  signingKey,
  saveCatalog,
  verifyCatalog,
} from "./catalog-lib.mjs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
const dev = process.argv.includes("--dev");
const components = (
  process.argv.find((a) => a.startsWith("--components="))?.split("=")[1] ||
  "node,caddy,php,composer,pnpm,yarn,cacert,mariadb,postgres"
).split(",");
const variants = [
  ["windows", "win", "x64"],
  ["macos", "darwin", "x64"],
  ["macos", "darwin", "arm64"],
  ["linux", "linux", "x64"],
];
const artifacts = [];
let historical = [];
try {
  historical = (await verifyCatalog()).artifacts;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const failures = [];
const downloadCache = path.join(root, ".local", "publisher-cache");
await mkdir(downloadCache, { recursive: true });
async function downloaded(url) {
  const key = sha256(url);
  const file = path.join(downloadCache, key);
  try {
    return await readFile(file);
  } catch {
    const bytes = await get(url, true);
    await writeFile(file, bytes);
    return bytes;
  }
}
function artifact(
  component,
  version,
  platform,
  arch,
  url,
  hash,
  archive,
  stripComponents,
  executables,
  license,
  sourceUrl,
  size = 0,
) {
  return {
    id: `${component}-${version}-${platform}-${arch}`,
    component,
    version,
    platform,
    arch,
    url,
    sha256: hash,
    archive,
    stripComponents,
    executables,
    license,
    sourceUrl,
    size,
  };
}
async function attempt(component, operation) {
  try {
    await operation();
    console.log(`Resolved ${component}`);
  } catch (error) {
    failures.push(`${component}: ${error.message}`);
    console.error(`${component}: ${error.message}`);
  }
}

if (components.includes("node"))
  await attempt("node", async () => {
    const releases = JSON.parse(
      await get("https://nodejs.org/dist/index.json"),
    );
    for (const branch of ["24.", "22."]) {
      const release = releases.find(
        (r) => r.version.startsWith(`v${branch}`) && r.lts,
      );
      if (!release) throw new Error(`No Node ${branch} LTS release`);
      const version = release.version.slice(1);
      const checks = await get(
        `https://nodejs.org/dist/v${version}/SHASUMS256.txt`,
      );
      for (const [platform, os, arch] of variants) {
        const file = `node-v${version}-${os}-${arch}.${platform === "windows" ? "zip" : "tar.gz"}`;
        const hash = checks
          .split("\n")
          .find((l) => l.endsWith(`  ${file}`))
          ?.split(/\s+/)[0];
        if (!hash) throw new Error(`Missing publisher checksum for ${file}`);
        artifacts.push(
          artifact(
            "node",
            version,
            platform,
            arch,
            `https://nodejs.org/dist/v${version}/${file}`,
            hash,
            platform === "windows" ? "zip" : "tar.gz",
            1,
            {
              node: platform === "windows" ? "node.exe" : "bin/node",
              npm:
                platform === "windows"
                  ? "node_modules/npm/bin/npm-cli.js"
                  : "lib/node_modules/npm/bin/npm-cli.js",
            },
            "MIT",
            "https://github.com/nodejs/node",
          ),
        );
      }
    }
  });
if (components.includes("caddy"))
  await attempt("caddy", async () => {
    const release = JSON.parse(
      await get(
        "https://api.github.com/repos/caddyserver/caddy/releases/latest",
      ),
    );
    const version = release.tag_name.replace(/^v/, "");
    const checksAsset = release.assets.find((a) =>
      /checksums\.txt$/.test(a.name),
    );
    if (!checksAsset) throw new Error("No publisher checksums");
    const checks = await get(checksAsset.browser_download_url);
    for (const [platform, os, arch] of variants) {
      const file = `caddy_${version}_${os === "darwin" ? "mac" : os === "win" ? "windows" : os}_${arch === "x64" ? "amd64" : arch}.${platform === "windows" ? "zip" : "tar.gz"}`;
      const asset = release.assets.find((a) => a.name === file);
      const line = checks.split("\n").find((l) => l.endsWith(file));
      if (!asset || !line) throw new Error(`Missing ${file}`);
      const publisherHash = line.trim().split(/\s+/)[0];
      let hash = asset.digest?.startsWith("sha256:")
        ? asset.digest.slice(7)
        : publisherHash;
      if (hash.length !== 64) {
        const bytes = await downloaded(asset.browser_download_url);
        const { createHash } = await import("node:crypto");
        const algorithm = publisherHash.length === 128 ? "sha512" : "sha256";
        if (createHash(algorithm).update(bytes).digest("hex") !== publisherHash)
          throw new Error(`Publisher checksum mismatch: ${file}`);
        hash = sha256(bytes);
      }
      artifacts.push(
        artifact(
          "caddy",
          version,
          platform,
          arch,
          asset.browser_download_url,
          hash,
          platform === "windows" ? "zip" : "tar.gz",
          0,
          { caddy: platform === "windows" ? "caddy.exe" : "caddy" },
          "Apache-2.0",
          "https://github.com/caddyserver/caddy",
          asset.size,
        ),
      );
    }
  });
if (components.includes("php"))
  await attempt("php", async () => {
    let releases;
    for (const endpoint of [
      "https://downloads.php.net/~windows/releases/releases.json",
      "https://windows.php.net/downloads/releases/releases.json",
    ]) {
      try {
        releases = JSON.parse(await get(endpoint));
        break;
      } catch {}
    }
    if (!releases)
      throw new Error(
        "PHP Windows publisher manifest unavailable; provide source-built artifacts with --extra=manifest.json",
      );
    for (const branch of ["8.5", "8.4"]) {
      const release = releases[branch];
      if (!release) throw new Error(`No PHP ${branch}`);
      const key = Object.keys(release).find((k) =>
        /nts.*x64|x64.*nts/i.test(k),
      );
      const build = release[key];
      const zip = build?.zip;
      if (!zip) throw new Error(`No PHP ${branch} x64 NTS ZIP`);
      const url = `https://downloads.php.net/~windows/releases/${zip.path}`;
      artifacts.push(
        artifact(
          "php",
          release.version,
          "windows",
          "x64",
          url,
          zip.sha256,
          "zip",
          0,
          { php: "php.exe", "php-cgi": "php-cgi.exe" },
          "PHP-3.01",
          "https://www.php.net/downloads.php",
        ),
      );
    }
  });
if (components.includes("composer"))
  await attempt("composer", async () => {
    const versions = JSON.parse(await get("https://getcomposer.org/versions"));
    const version = versions.stable[0].version;
    const url = `https://getcomposer.org/download/${version}/composer.phar`;
    const bytes = await downloaded(url);
    for (const [platform, , arch] of variants)
      artifacts.push(
        artifact(
          "composer",
          version,
          platform,
          arch,
          url,
          sha256(bytes),
          "file",
          0,
          { composer: "composer.phar" },
          "MIT",
          "https://github.com/composer/composer",
          bytes.length,
        ),
      );
  });
for (const component of ["pnpm", "yarn"])
  if (components.includes(component))
    await attempt(component, async () => {
      const metadata = JSON.parse(
        // Keep the self-contained JS distribution; pnpm 12's npm shim downloads native optional dependencies.
        await get(
          `https://registry.npmjs.org/${component}/${component === "pnpm" ? "latest-10" : "latest"}`,
        ),
      );
      const entrypoint =
        typeof metadata.bin === "string"
          ? metadata.bin
          : metadata.bin?.[component];
      if (
        typeof entrypoint !== "string" ||
        !/^[a-zA-Z0-9_./-]+\.(cjs|js)$/.test(entrypoint) ||
        entrypoint.includes("..")
      )
        throw new Error(
          "Expected a self-contained JavaScript package manager entrypoint",
        );
      const url = metadata.dist.tarball;
      const bytes = await downloaded(url);
      // npm's published integrity must match before this package enters our signed catalog.
      const { createHash } = await import("node:crypto");
      if (metadata.dist.integrity) {
        const [algorithm, expected] = metadata.dist.integrity.split("-");
        if (createHash(algorithm).update(bytes).digest("base64") !== expected)
          throw new Error("Publisher integrity mismatch");
      }
      for (const [platform, , arch] of variants)
        artifacts.push(
          artifact(
            component,
            metadata.version,
            platform,
            arch,
            url,
            sha256(bytes),
            "tar.gz",
            1,
            { [component]: entrypoint.replace(/^\.\//, "") },
            "MIT",
            `https://registry.npmjs.org/${component}`,
            bytes.length,
          ),
        );
    });
const extra = process.argv.find((a) => a.startsWith("--extra="))?.slice(8);
if (components.includes("cacert"))
  await attempt("cacert", async () => {
    const url = "https://curl.se/ca/cacert.pem";
    const bytes = await downloaded(url);
    const hash = sha256(bytes);
    for (const [platform, , arch] of variants)
      artifacts.push(
        artifact(
          "cacert",
          hash.slice(0, 12),
          platform,
          arch,
          url,
          hash,
          "file",
          0,
          { cacert: "cacert.pem" },
          "MPL-2.0",
          "https://curl.se/docs/caextract.html",
          bytes.length,
        ),
      );
  });
if (components.includes("mariadb"))
  await attempt("mariadb", async () => {
    const version = "12.3.3";
    const url = `https://archive.mariadb.org/mariadb-${version}/winx64-packages/mariadb-${version}-winx64.zip`;
    const bytes = await downloaded(url);
    artifacts.push(
      artifact(
        "mariadb",
        version,
        "windows",
        "x64",
        url,
        sha256(bytes),
        "zip",
        1,
        {
          mariadbd: "bin/mariadbd.exe",
          mariadb: "bin/mariadb.exe",
          "mariadb-dump": "bin/mariadb-dump.exe",
          "install-db": "bin/mysql_install_db.exe",
        },
        "GPL-2.0-only",
        "https://github.com/MariaDB/server",
        bytes.length,
      ),
    );
  });
if (components.includes("postgres"))
  await attempt("postgres", async () => {
    const version = "18.6";
    const url = `https://get.enterprisedb.com/postgresql/postgresql-${version}-1-windows-x64-binaries.zip`;
    const bytes = await downloaded(url);
    artifacts.push(
      artifact(
        "postgres",
        version,
        "windows",
        "x64",
        url,
        sha256(bytes),
        "zip",
        1,
        Object.fromEntries(
          ["postgres", "initdb", "psql", "pg_dump", "pg_ctl"].map((tool) => [
            tool,
            `bin/${tool}.exe`,
          ]),
        ),
        "PostgreSQL",
        "https://www.postgresql.org/download/windows/",
        bytes.length,
      ),
    );
  });
if (extra) artifacts.push(...JSON.parse(await readFile(extra, "utf8")));
if (!artifacts.length)
  throw new Error(
    "No verified artifacts resolved. Existing catalog was preserved.",
  );
if (failures.length) {
  throw new Error(
    `Catalog has unresolved components; existing catalog was preserved:\n${failures.join("\n")}`,
  );
}
const retained = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
for (const artifact of historical) {
  const current = retained.get(artifact.id);
  if (current && current.sha256 !== artifact.sha256)
    throw new Error(
      `Refusing to replace immutable runtime ${artifact.id} with different bytes`,
    );
  if (!current) retained.set(artifact.id, artifact);
}
await saveCatalog([...retained.values()], await signingKey(dev), dev);
