// Replace the catalog only in this ephemeral QA build, never the normal checkout.
import { copyFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { root } from "./catalog-lib.mjs";
import { verifyQaDesktopPack } from "./qa-desktop-lib.mjs";

if (
  process.env.GITHUB_ACTIONS !== "true" ||
  !process.env.GITHUB_ENV ||
  !process.env.STACKCABIN_QA_KIT_DIR
)
  throw new Error(
    "Desktop QA preparation requires an ephemeral GitHub Actions checkout and a matching kit",
  );
const platform = process.platform === "darwin" ? "macos" : "linux";
const arch = process.arch;
const offline = path.join(process.env.STACKCABIN_QA_KIT_DIR, "offline");
await verifyQaDesktopPack(offline, platform, arch);
for (const file of [
  "catalog.json",
  "catalog.sig",
  "public-key.txt",
  "provenance.json",
])
  await copyFile(
    path.join(offline, file),
    path.join(root, "runtime-catalog", file),
  );
await appendFile(
  process.env.GITHUB_ENV,
  `STACKCABIN_E2E_OFFLINE=${offline}\nSTACKCABIN_E2E_QA=1\nSTACKCABIN_E2E_BINARY=${path.join(root, "target/debug/stackcabin-qa")}\n`,
);
console.log(
  `Verified matching signed catalog and every offline archive for ${platform}/${arch}. QA identity: dev.stackcabin.qa`,
);
