import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { root } from "./catalog-lib.mjs";

const sections = [
  "StackCabin third-party notices\nGenerated from installed npm packages and the local Cargo registry.\n" +
    "Runtime archives retain their upstream license files. Runtime source URLs and license identifiers are listed below.\n" +
    "Public releases require a platform-specific license and corresponding-source audit; this inventory is not that certification.\n",
];
async function notices(folder) {
  let names;
  try {
    names = await readdir(folder);
  } catch {
    return "License files unavailable in this checkout.\n";
  }
  const files = names.filter((name) =>
    /^(licen[sc]e|copying|notice|copyright)([.-].*)?$/i.test(name),
  );
  const contents = [];
  for (const name of files) {
    try {
      contents.push(
        `--- ${name} ---\n${await readFile(path.join(folder, name), "utf8")}`,
      );
    } catch {
      /* A license directory is listed in the package archive. */
    }
  }
  return (
    contents.join("\n") ||
    "See the publisher's package archive for license text.\n"
  );
}

const lock = JSON.parse(
  await readFile(path.join(root, "package-lock.json"), "utf8"),
);
for (const [relative, pkg] of Object.entries(lock.packages)) {
  if (!relative || pkg.dev) continue;
  const folder = path.join(root, relative);
  const name = pkg.name || relative.split("node_modules/").at(-1);
  sections.push(
    `\n========== npm: ${name} ${pkg.version} (${pkg.license || "see package"}) ==========\n${await notices(folder)}`,
  );
}

const registry = path.join(
  process.env.CARGO_HOME || path.join(os.homedir(), ".cargo"),
  "registry",
  "src",
);
let registries = [];
try {
  registries = await readdir(registry);
} catch {
  /* Inventory can be generated before Cargo fetches packages. */
}
const cargo = await readFile(path.join(root, "Cargo.lock"), "utf8");
for (const block of cargo.split("[[package]]").slice(1)) {
  if (!/^source = "registry\+/m.test(block)) continue;
  const name = block.match(/^name = "([^"]+)"/m)?.[1];
  const version = block.match(/^version = "([^"]+)"/m)?.[1];
  let text =
    "Not cached on this platform; inspect this crate's source archive for other target platforms.\n";
  for (const source of registries) {
    const folder = path.join(registry, source, `${name}-${version}`);
    try {
      await readdir(folder);
      text = await notices(folder);
      break;
    } catch {
      /* Try the next Cargo registry. */
    }
  }
  sections.push(
    `\n========== Cargo: ${name} ${version} ==========\nhttps://crates.io/crates/${name}/${version}\n${text}`,
  );
}
const catalog = JSON.parse(
  await readFile(path.join(root, "runtime-catalog", "catalog.json"), "utf8"),
);
sections.push(
  "\n========== Managed runtime source and license inventory ==========\n",
);
for (const artifact of catalog.artifacts) {
  sections.push(
    `${artifact.id}\nLicense: ${artifact.license}\nSource: ${artifact.sourceUrl}\nPackage: ${artifact.url}\nSHA-256: ${artifact.sha256}\n`,
  );
}
await mkdir(path.join(root, "resources"), { recursive: true });
const prerequisites = JSON.parse(await readFile(path.join(root, "runtime-catalog", "windows-prerequisites.json"), "utf8"));
sections.push(
  `\n========== Microsoft Visual C++ x64 prerequisite ==========\nVersion: ${prerequisites.visualCpp.version}\nPublisher: ${prerequisites.visualCpp.publisher}\nPackage: ${prerequisites.visualCpp.url}\nSHA-256: ${prerequisites.visualCpp.sha256}\nDocumentation and redistribution terms: ${prerequisites.visualCpp.documentation}\nMicrosoft's license terms apply to this redistributable; StackCabin's MIT license does not replace them.\n`,
);
await writeFile(
  path.join(root, "resources", "THIRD_PARTY_NOTICES.txt"),
  sections.join("\n"),
);
console.log("Generated resources/THIRD_PARTY_NOTICES.txt");
