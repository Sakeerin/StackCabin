import { createHash } from "node:crypto";
import path from "node:path";

const hash = (value) => /^[a-f0-9]{64}$/.test(value || "");
const packageName = (value) => /^[a-z0-9][a-z0-9+.-]*$/.test(value || "");
const version = (value) => /^[0-9][A-Za-z0-9.+:~_-]*$/.test(value || "");
const relative = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9+._/-]+$/.test(value) &&
  !value.startsWith("/") &&
  value.split("/").every((part) => part && part !== "." && part !== "..");
const record = (value) =>
  value &&
  hash(value.sha256) &&
  Number.isSafeInteger(value.size) &&
  value.size > 0;
const unique = (values) => new Set(values).size === values.length;

// The producer verifies DSC members and the final runtime's library/license
// bytes. Release assembly also requires the complete mapping and source bundles.
export async function linuxReleaseSources(directory, proof, id, asset) {
  const fail = () => {
    throw new Error(`Incomplete verified Ubuntu source closure: ${id}`);
  };
  const checks = [
    "exact Ubuntu source versions",
    "descriptor SHA-256 closure",
    "source bundle members",
    "packaged library and license bytes",
  ];
  if (
    proof?.schemaVersion !== 1 ||
    proof.distribution !== "ubuntu" ||
    proof.distributionVersion !== "22.04" ||
    proof.verification?.result !== "passed" ||
    !checks.every((check) => proof.verification.checks?.includes(check)) ||
    !Array.isArray(proof.libraries) ||
    !proof.libraries.length ||
    !Array.isArray(proof.packages) ||
    !proof.packages.length ||
    !Array.isArray(proof.commonLicenses) ||
    !proof.commonLicenses.length ||
    !unique(proof.libraries.map((entry) => entry.path)) ||
    !unique(proof.packages.map((entry) => `${entry.name}=${entry.version}`)) ||
    !unique(proof.commonLicenses.map((entry) => entry.path))
  )
    fail();
  for (const license of proof.commonLicenses) {
    if (
      !record(license) ||
      !relative(license.path) ||
      !license.path.startsWith("share/licenses/ubuntu/common/") ||
      license.path !== `share/licenses/ubuntu/common/${license.name}`
    )
      fail();
  }
  for (const library of proof.libraries) {
    const owner = proof.packages.find(
      (entry) =>
        entry.name === library.sourcePackage &&
        entry.version === library.sourceVersion,
    );
    const binary = library.binaryPackage?.split(":")[0];
    if (
      !owner ||
      !packageName(binary) ||
      library.architecture !== "amd64" ||
      !version(library.binaryVersion) ||
      !owner.binaryPackages?.includes(library.binaryPackage) ||
      !hash(library.sha256) ||
      !relative(library.path) ||
      !library.path.startsWith("lib/") ||
      !record(library.copyright) ||
      library.copyright.path !== `share/licenses/ubuntu/${binary}/copyright`
    )
      fail();
  }
  const inventory = [];
  for (const group of proof.packages) {
    const identifier = createHash("sha256")
      .update(`${group.name}=${group.version}`)
      .digest("hex")
      .slice(0, 24);
    const component = id.split("-")[0];
    const libraries = proof.libraries.filter(
      (entry) =>
        entry.sourcePackage === group.name &&
        entry.sourceVersion === group.version,
    );
    if (
      !packageName(group.name) ||
      !version(group.version) ||
      !Array.isArray(group.binaryPackages) ||
      !group.binaryPackages.length ||
      !unique(group.binaryPackages) ||
      !group.binaryPackages.every((binary) =>
        libraries.some((entry) => entry.binaryPackage === binary),
      ) ||
      !Array.isArray(group.files) ||
      group.files.length < 2 ||
      !unique(group.files.map((file) => file.name)) ||
      !Array.isArray(group.licenses) ||
      !unique(group.licenses.map((file) => file.name)) ||
      !record(group.bundle) ||
      group.bundle.file !== `${component}-linux-source-${identifier}.tar`
    )
      fail();
    for (const file of group.files) {
      let url;
      try {
        url = new URL(file.url);
      } catch {
        fail();
      }
      if (
        !record(file) ||
        !/^[A-Za-z0-9][A-Za-z0-9+._~-]*$/.test(file.name) ||
        file.name === ".." ||
        url.protocol !== "https:" ||
        !["archive.ubuntu.com", "security.ubuntu.com"].includes(url.hostname) ||
        url.username ||
        url.password
      )
        fail();
    }
    const descriptors = group.files.filter((file) =>
      file.name.endsWith(".dsc"),
    );
    if (
      descriptors.length !== 1 ||
      ["name", "size", "sha256", "url"].some(
        (key) => group.descriptor?.[key] !== descriptors[0][key],
      )
    )
      fail();
    const licenses = new Map(
      proof.commonLicenses.map((entry) => [
        `licenses/common/${entry.name}`,
        entry,
      ]),
    );
    for (const library of libraries)
      licenses.set(
        `licenses/${library.binaryPackage.split(":")[0]}/copyright`,
        library.copyright,
      );
    if (
      group.licenses.length !== licenses.size ||
      group.licenses.some(
        (entry) =>
          !record(entry) ||
          !licenses.has(entry.name) ||
          ["size", "sha256"].some(
            (key) => entry[key] !== licenses.get(entry.name)[key],
          ),
      )
    )
      fail();
    const file = await asset(
      path.join(directory, group.bundle.file),
      `source-${group.bundle.sha256}.tar`,
      group.bundle,
    );
    inventory.push({
      kind: "ubuntu-source-package",
      name: group.name,
      version: group.version,
      descriptorUrl: group.descriptor.url,
      descriptorSha256: group.descriptor.sha256,
      file,
      sha256: group.bundle.sha256,
      archive: "tar",
      files: group.files,
      licenses: group.licenses,
      binaryPackages: group.binaryPackages,
      usedBy: [id],
    });
  }
  return inventory;
}
