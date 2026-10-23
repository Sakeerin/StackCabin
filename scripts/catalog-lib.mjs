import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
export const root = path.resolve(import.meta.dirname, "..");
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export async function get(url, binary = false) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "StackCabin-catalog-builder/0.1",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(binary ? 1_800_000 : 60_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return binary ? Buffer.from(await response.arrayBuffer()) : response.text();
}
export async function signingKey(dev) {
  if (process.env.STACKCABIN_CATALOG_PRIVATE_KEY)
    return createPrivateKey(
      process.env.STACKCABIN_CATALOG_PRIVATE_KEY.replaceAll("\\n", "\n"),
    );
  if (!dev)
    throw new Error(
      "Set STACKCABIN_CATALOG_PRIVATE_KEY for release catalogs, or explicitly pass --dev for local development.",
    );
  const folder = path.join(root, ".local");
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, "catalog-dev-private.pem");
  try {
    return createPrivateKey(await readFile(file));
  } catch {
    const { privateKey } = generateKeyPairSync("ed25519");
    await writeFile(file, privateKey.export({ type: "pkcs8", format: "pem" }), {
      mode: 0o600,
    });
    return privateKey;
  }
}
export async function saveCatalog(artifacts, key, dev) {
  for (const artifact of artifacts)
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256))
      throw new Error(
        `Refusing to sign invalid SHA256 metadata: ${artifact.id}`,
      );
  const bytes = Buffer.from(
    JSON.stringify(
      { schemaVersion: 1, generatedAt: new Date().toISOString(), artifacts },
      null,
      2,
    ) + "\n",
  );
  const directory = path.join(root, "runtime-catalog");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "catalog.json"), bytes);
  await writeFile(
    path.join(directory, "catalog.sig"),
    sign(null, bytes, key).toString("base64") + "\n",
  );
  const pub = createPublicKey(key)
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  await writeFile(
    path.join(directory, "public-key.txt"),
    pub.toString("base64") + "\n",
  );
  await writeFile(
    path.join(directory, "provenance.json"),
    JSON.stringify(
      {
        developmentKey: dev,
        generatedAt: new Date().toISOString(),
        artifacts: artifacts.map((a) => ({
          id: a.id,
          url: a.url,
          sourceUrl: a.sourceUrl,
          sha256: a.sha256,
        })),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Signed ${artifacts.length} artifacts${dev ? " using a LOCAL DEVELOPMENT key" : ""}.`,
  );
}
export async function verifyCatalog(
  directory = path.join(root, "runtime-catalog"),
  release = false,
) {
  const bytes = await readFile(path.join(directory, "catalog.json"));
  const signature = Buffer.from(
    (await readFile(path.join(directory, "catalog.sig"), "utf8")).trim(),
    "base64",
  );
  const raw = Buffer.from(
    (await readFile(path.join(directory, "public-key.txt"), "utf8")).trim(),
    "base64",
  );
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
    type: "spki",
    format: "der",
  });
  if (!verify(null, bytes, key, signature))
    throw new Error("Invalid catalog signature");
  const catalog = JSON.parse(bytes);
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.artifacts))
    throw new Error("Unsupported catalog");
  const seen = new Set();
  for (const a of catalog.artifacts) {
    if (!/^[a-zA-Z0-9._-]+$/.test(a.id) || seen.has(a.id))
      throw new Error(`Invalid/duplicate id: ${a.id}`);
    seen.add(a.id);
    if (!/^[a-f0-9]{64}$/.test(a.sha256) || !a.url.startsWith("https://"))
      throw new Error(`Invalid integrity metadata: ${a.id}`);
  }
  if (release) {
    for (const artifact of catalog.artifacts) {
      if (artifact.platform === "macos" && artifact.minimumOsVersion) {
        const [major, minor = 0] = artifact.minimumOsVersion
          .split(".")
          .map(Number);
        if (
          !Number.isFinite(major) ||
          major > 14 ||
          (major === 14 && minor > 0)
        )
          throw new Error(
            "Release blocked: " +
              artifact.id +
              " requires macOS " +
              artifact.minimumOsVersion +
              "; the supported baseline is 14.0.",
          );
      }
    }
    const provenance = JSON.parse(
      await readFile(path.join(directory, "provenance.json"), "utf8"),
    );
    if (provenance.developmentKey)
      throw new Error(
        "Release blocked: replace the development key with a production catalog signing key.",
      );
    const required = [
      "node",
      "php",
      "composer",
      "caddy",
      "mariadb",
      "postgres",
      "pnpm",
      "yarn",
    ];
    for (const [platform, arch] of [
      ["windows", "x64"],
      ["macos", "x64"],
      ["macos", "arm64"],
      ["linux", "x64"],
    ]) {
      for (const component of required)
        if (
          !catalog.artifacts.some(
            (a) =>
              a.platform === platform &&
              a.arch === arch &&
              a.component === component,
          )
        )
          throw new Error(
            `Release blocked: missing ${component} for ${platform}/${arch}`,
          );
      for (const [component, branches] of [
        ["php", ["8.4.", "8.5."]],
        ["node", ["22.", "24."]],
      ])
        for (const branch of branches)
          if (
            !catalog.artifacts.some(
              (a) =>
                a.platform === platform &&
                a.arch === arch &&
                a.component === component &&
                a.version.startsWith(branch),
            )
          )
            throw new Error(
              `Release blocked: missing ${component} ${branch} for ${platform}/${arch}`,
            );
    }
  }
  return catalog;
}
