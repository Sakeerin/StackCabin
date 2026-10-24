// A matching test binary + offline catalog; never includes CI keychains or keys.
import {
  copyFile,
  mkdir,
  writeFile,
  chmod,
  readFile,
  cp,
} from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { root, sha256 } from "./catalog-lib.mjs";

if (
  process.env.GITHUB_ACTIONS !== "true" ||
  !process.env.STACKCABIN_OFFLINE_DIR
)
  throw new Error("Package only the ephemeral combined-stack CI checkout");
const platform = process.platform === "darwin" ? "macos" : "linux";
const arch = process.env.STACKCABIN_TEST_ARCH || process.arch;
if (!["x64", "arm64"].includes(arch))
  throw new Error("Unsupported QA architecture");
const name = `native-qa-${platform}-${arch}`;
const directory = path.join(root, "artifacts", name);
await mkdir(directory); // Refuse mixing a previous kit with another catalog.
const target = process.env.CARGO_BUILD_TARGET || "";
const binary = path.join(
  root,
  "target",
  target,
  "release/examples/native-smoke",
);
await copyFile(binary, path.join(directory, "native-smoke"));
await chmod(path.join(directory, "native-smoke"), 0o755);
for (const [source, destination] of [
  ["scripts/Run-StackCabinAcceptance.sh", "Run-StackCabinAcceptance.sh"],
  ["docs/VM_ACCEPTANCE.md", "VM_ACCEPTANCE.md"],
  ["LICENSE", "LICENSE"],
  ["resources/THIRD_PARTY_NOTICES.txt", "THIRD_PARTY_NOTICES.txt"],
  ["runtime-catalog/native-test-builds.json", "NATIVE_BUILD_SELECTIONS.json"],
])
  await copyFile(path.join(root, source), path.join(directory, destination));
await chmod(path.join(directory, "Run-StackCabinAcceptance.sh"), 0o755);
await cp(process.env.STACKCABIN_OFFLINE_DIR, path.join(directory, "offline"), {
  recursive: true,
});
const hash = sha256(await readFile(binary));
await writeFile(
  path.join(directory, "SHA256SUMS.txt"),
  `${hash}  native-smoke\n`,
);
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
await writeFile(path.join(directory, "SOURCE_COMMIT.txt"), commit + "\n");
await writeFile(
  path.join(directory, "INTERNAL_TEST_ONLY.txt"),
  `StackCabin ${platform}/${arch} internal VM acceptance kit.\nUses an ephemeral DEVELOPMENT catalog key compiled into this harness.\nIts offline pack is for this harness, not the shipping application.\nRun as an ordinary desktop user with an unlocked OS credential store.\nNo framework dependencies, application installer, production signing or certification included.\n`,
);
const archive = path.join(root, "artifacts", name + ".tar.gz");
execFileSync("tar", ["-czf", archive, "-C", directory, "."], {
  stdio: "inherit",
});
await writeFile(
  archive + ".sha256",
  `${sha256(await readFile(archive))}  ${name}.tar.gz\n`,
);
console.log(
  `Packaged internal QA kit for ${platform}/${arch}; no private key or test credentials included.`,
);
