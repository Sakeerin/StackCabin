import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { proposalFixture } from "./catalog-proposal.mjs";
import { digest, jsonBytes } from "./native-release.mjs";
import { prepareCatalogProposal } from "../../scripts/prepare-catalog-proposal.mjs";
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const publicBytes = (key) =>
  Buffer.from(
    createPublicKey(key)
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64") + "\n",
  );

export async function signingFixture(t, hosted = true) {
  const f = await proposalFixture(t);
  // Synthetic transfer bytes and ephemeral keys exercise the signing boundary.
  // This fixture is not public-hosted release or clean-machine acceptance evidence.
  await prepareCatalogProposal({
    ...f.settings,
    hosted,
    transport: {
      fetchImpl: async (url) =>
        new Response(
          await readFile(
            path.join(f.directory, new URL(url).pathname.split("/").at(-1)),
          ),
        ),
    },
  });
  const key = generateKeyPairSync("ed25519").privateKey;
  let keyReads = 0;
  const settings = {
    directory: f.settings.output,
    handoffSha256: digest(
      await readFile(path.join(f.settings.output, "CATALOG_HANDOFF.json")),
    ),
    basePublicKeySha256: f.settings.publicKeySha256,
    publicKeySha256: digest(publicBytes(key)),
    output: path.join(f.root, "signed"),
    loadPrivateKey: () => {
      keyReads++;
      return key;
    },
  };
  const repin = async (change) => {
    const file = path.join(settings.directory, "CATALOG_HANDOFF.json");
    const receipt = await readJson(file);
    for (const entry of receipt.files) {
      const bytes = await readFile(path.join(settings.directory, entry.name));
      Object.assign(entry, { size: bytes.length, sha256: digest(bytes) });
    }
    change?.(receipt);
    const bytes = jsonBytes(receipt);
    await writeFile(file, bytes);
    settings.handoffSha256 = digest(bytes);
  };
  const change = async (name, mutate) => {
    const file = path.join(settings.directory, name);
    const value = await readJson(file);
    mutate(value);
    await writeFile(file, jsonBytes(value));
  };
  return {
    ...f,
    key,
    signing: settings,
    repin,
    change,
    keyReads: () => keyReads,
  };
}
