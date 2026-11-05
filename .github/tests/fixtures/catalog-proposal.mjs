import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture, digest, jsonBytes } from "./native-release.mjs";
export async function proposalFixture(t, changeBase) {
  const f = await fixture(t);
  const catalogDirectory = path.join(f.root, "base");
  await mkdir(catalogDirectory);
  const base = JSON.parse(
    await readFile(
      new URL("../../../runtime-catalog/catalog.json", import.meta.url),
      "utf8",
    ),
  );
  changeBase?.(base, f);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyBytes = Buffer.from(
    publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64") + "\n",
  );
  const resign = async () => {
    const bytes = jsonBytes(base);
    await writeFile(path.join(catalogDirectory, "catalog.json"), bytes);
    await writeFile(
      path.join(catalogDirectory, "catalog.sig"),
      sign(null, bytes, privateKey).toString("base64") + "\n",
    );
    await writeFile(path.join(catalogDirectory, "public-key.txt"), keyBytes);
  };
  await resign();
  return {
    ...f,
    base,
    resign,
    settings: {
      ...f.options,
      directory: f.directory,
      catalogDirectory,
      publicKeySha256: digest(keyBytes),
      output: path.join(f.root, "proposal"),
    },
  };
}
