import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  prepareNativeRelease,
  releaseBase,
  releaseSelections,
  verifyProducer,
} from "./prepare-native-release.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const repository = "Sakeerin/StackCabin";
const tag = "native-test-20261103";
const tools = {
  php: { php: "bin/php", "php-fpm": "sbin/php-fpm" },
  mariadb: {
    mariadbd: "bin/mariadbd",
    mariadb: "bin/mariadb",
    "mariadb-dump": "bin/mariadb-dump",
    "install-db": "scripts/mariadb-install-db",
  },
  postgres: {
    postgres: "bin/postgres",
    initdb: "bin/initdb",
    psql: "bin/psql",
    pg_dump: "bin/pg_dump",
    pg_ctl: "bin/pg_ctl",
  },
};
const licenses = {
  php: "PHP-3.01",
  mariadb: "GPL-2.0-only",
  postgres: "PostgreSQL",
};
const selections = {
  targets: Object.fromEntries(
    ["linux-x64", "macos-arm64", "macos-x64"].map((target) => [
      target,
      [
        ["php", "8.4.27"],
        ["php", "8.5.12"],
        ["mariadb", "12.3.3"],
        ["postgres", "18.6"],
      ].map(([component, version], index) => ({
        component,
        version,
        run: String(index + 1),
        artifact: `${component}-${version}-${target}`,
      })),
    ]),
  ),
};
function producer(build) {
  return {
    id: Number(build.run),
    status: "completed",
    conclusion: "success",
    event: "workflow_dispatch",
    path: ".github/workflows/native-runtime.yml",
    head_sha: "a".repeat(40),
    repository: { full_name: repository },
    head_repository: { full_name: repository },
  };
}

async function fixture(t) {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "stackcabin-release-"),
  );
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const builds = releaseSelections(selections);
  const sources = selections.targets["linux-x64"].map((build) => ({
    ...build,
    sourceUrl: `https://publisher.test/${build.component}-${build.version}.tar.gz`,
    sourceSha256: hash(`source-${build.component}-${build.version}`),
  }));
  const dependency = {
    name: "crypto",
    version: "1.0",
    license: "MIT",
    url: "https://publisher.test/crypto.tar.gz",
    sha256: hash("crypto-source"),
  };
  const inputs = [];
  for (const build of builds) {
    const directory = path.join(temporary, build.id);
    await mkdir(directory);
    const source = sources.find(
      (s) => s.component === build.component && s.version === build.version,
    );
    const metadata = {
      ...build,
      url: `https://old.test/${build.id}.tar.gz`,
      archive: "tar.gz",
      sha256: hash(build.id),
      size: Buffer.byteLength(build.id),
      stripComponents: 1,
      executables: tools[build.component],
      license: licenses[build.component],
      sourceUrl: source.sourceUrl,
      ...(build.platform === "macos" ? { minimumOsVersion: "14.0" } : {}),
    };
    const dependencies =
      build.platform === "macos"
        ? [{ ...dependency, deploymentTarget: "14.0" }]
        : [];
    const linuxBundle = Buffer.from("matched Ubuntu source bundle");
    const copyright = {
      name: "copyright",
      path: "share/licenses/ubuntu/libexample1/copyright",
      size: 7,
      sha256: hash("license"),
    };
    const common = {
      name: "GPL-3",
      path: "share/licenses/ubuntu/common/GPL-3",
      size: 6,
      sha256: hash("common"),
    };
    const linuxFiles = [
      {
        name: "example_1.0-1.dsc",
        size: 10,
        sha256: hash("descriptor"),
        url: "https://archive.ubuntu.com/ubuntu/pool/main/e/example/example_1.0-1.dsc",
      },
      {
        name: "example_1.0.orig.tar.gz",
        size: 6,
        sha256: hash("source"),
        url: "https://archive.ubuntu.com/ubuntu/pool/main/e/example/example_1.0.orig.tar.gz",
      },
    ];
    const linuxSourceName = `${build.component}-linux-source-${hash("example=1.0-1").slice(0, 24)}.tar`;
    const linuxSources =
      build.platform === "linux"
        ? {
            schemaVersion: 1,
            distribution: "ubuntu",
            distributionVersion: "22.04",
            verification: {
              result: "passed",
              checks: [
                "exact Ubuntu source versions",
                "descriptor SHA-256 closure",
                "source bundle members",
                "packaged library and license bytes",
              ],
            },
            commonLicenses: [common],
            libraries: [
              {
                path: "lib/libexample.so.1",
                sha256: hash("library"),
                binaryPackage: "libexample1:amd64",
                binaryVersion: "1.0-1",
                architecture: "amd64",
                sourcePackage: "example",
                sourceVersion: "1.0-1",
                copyright,
              },
            ],
            packages: [
              {
                name: "example",
                version: "1.0-1",
                binaryPackages: ["libexample1:amd64"],
                files: linuxFiles,
                descriptor: linuxFiles[0],
                licenses: [
                  { ...copyright, name: "licenses/libexample1/copyright" },
                  { ...common, name: "licenses/common/GPL-3" },
                ],
                bundle: {
                  file: linuxSourceName,
                  size: linuxBundle.length,
                  sha256: hash(linuxBundle),
                },
              },
            ],
          }
        : undefined;
    const files = {
      [`${build.id}.json`]: JSON.stringify(metadata),
      [`${build.id}-provenance.json`]: JSON.stringify({
        sourceUrl: source.sourceUrl,
        sourceSha256: source.sourceSha256,
        minimumOsVersion: metadata.minimumOsVersion,
        verification: {
          component: build.component,
          version: build.version,
          result: "passed",
        },
        dependencies,
        linuxSources,
      }),
      [`${build.id}.tar.gz`]: build.id,
      [`${build.id}-source.tar.gz`]: `source-${build.component}-${build.version}`,
      ...(linuxSources ? { [linuxSourceName]: linuxBundle } : {}),
      ...(dependencies.length
        ? {
            [`${build.component}-dependency-provenance.json`]:
              JSON.stringify(dependencies),
            [`${build.component}-dependency-crypto.tar.gz`]: "crypto-source",
          }
        : {}),
    };
    for (const [name, bytes] of Object.entries(files))
      await writeFile(path.join(directory, name), bytes);
    inputs.push({ id: build.id, directory, run: producer(build) });
  }
  return {
    inputs,
    selections: structuredClone(selections),
    sources,
    dependencySources: Object.fromEntries(
      Object.keys(tools).map((name) => [name, [dependency]]),
    ),
    repository,
    tag,
    output: path.join(temporary, "prepared"),
  };
}
async function mutate(input, suffix, change) {
  const file = path.join(input.directory, input.id + suffix);
  const value = JSON.parse(await readFile(file, "utf8"));
  change(value);
  await writeFile(file, JSON.stringify(value));
}

test("stages all twelve exact runtime identities and preserves producer metadata", async (t) => {
  const options = await fixture(t);
  const result = await prepareNativeRelease(options);
  assert.equal(result.runtimeCount, 12);
  assert.equal(result.published, false);
  assert.equal(result.catalogSigned, false);
  const candidate = JSON.parse(
    await readFile(path.join(options.output, "native-artifacts.json")),
  );
  assert.ok(
    candidate.every(
      (a) => a.url === `${releaseBase(repository, tag)}/${a.id}.tar.gz`,
    ),
  );
  assert.equal(
    JSON.parse(
      await readFile(path.join(options.output, options.inputs[0].id + ".json")),
    ).url.startsWith("https://old.test/"),
    true,
  );
  assert.equal(
    (await readdir(options.output)).filter((name) => name.startsWith("source-"))
      .length,
    7,
  ); // Six source archives plus the inventory.
  for (const line of (
    await readFile(path.join(options.output, "SHA256SUMS.txt"), "utf8")
  )
    .trim()
    .split("\n")) {
    const [digest, name] = line.split("  ");
    assert.equal(hash(await readFile(path.join(options.output, name))), digest);
  }
});

test("rejects incomplete/duplicate runtime inputs before creating output", async (t) => {
  const options = await fixture(t);
  for (const inputs of [
    options.inputs.slice(1),
    [...options.inputs.slice(1), options.inputs[1]],
  ])
    await assert.rejects(
      prepareNativeRelease({ ...options, inputs }),
      /exactly once/,
    );
  await assert.rejects(
    readFile(path.join(options.output, "release-manifest.json")),
    { code: "ENOENT" },
  );
});

test("requires exact supported targets and both PHP branches", () => {
  for (const change of [
    (s) => delete s.targets["linux-x64"],
    (s) => (s.targets["windows-x64"] = []),
    (s) => (s.targets["macos-x64"][1].version = "8.4.28"),
  ]) {
    const changed = structuredClone(selections);
    change(changed);
    assert.throws(() => releaseSelections(changed), /targets|matrix/);
  }
});

test("rejects mutable/unsafe release destinations", () => {
  for (const bad of [
    "latest",
    "../native-one",
    "native-a/b",
    "native-a..b",
    "native-a.lock",
    "native-a.",
    "native-a?x=1",
  ])
    assert.throws(() => releaseBase(repository, bad), /immutable/);
  for (const bad of ["a/b/c", "../repo", "a/b?x=1"])
    assert.throws(() => releaseBase(bad, tag), /repository/);
});

test("requires successful exact producer runs from the expected workflow and repository", () => {
  const build = releaseSelections(selections)[0];
  for (const change of [
    { id: 999 },
    { status: "in_progress" },
    { conclusion: "failure" },
    { event: "pull_request" },
    { path: ".github/workflows/qa-desktop.yml" },
    { head_sha: "x" },
    { repository: { full_name: "fork/StackCabin" } },
    { head_repository: null },
  ])
    assert.throws(
      () =>
        verifyProducer({ ...producer(build), ...change }, build, repository),
      /successful native producer/,
    );
});

test("preserves an existing review directory rather than overwriting it", async (t) => {
  const options = await fixture(t);
  await mkdir(options.output);
  await writeFile(path.join(options.output, "keep.txt"), "existing-review");
  await assert.rejects(prepareNativeRelease(options), { code: "EEXIST" });
  assert.deepEqual(await readdir(options.output), ["keep.txt"]);
});

test("rejects corrupt runtime and main publisher source bytes", async (t) => {
  for (const suffix of [".tar.gz", "-source.tar.gz"]) {
    const options = await fixture(t);
    await writeFile(
      path.join(options.inputs[0].directory, options.inputs[0].id + suffix),
      "corrupt",
    );
    await assert.rejects(prepareNativeRelease(options), /mismatch/);
    await assert.rejects(
      readFile(path.join(options.output, "release-manifest.json")),
      { code: "ENOENT" },
    );
  }
});

test("rejects executable traversal and unexpected strip/license metadata", async (t) => {
  for (const change of [
    (m) => (m.executables.php = "../../evil"),
    (m) => (m.stripComponents = 0),
    (m) => (m.license = "MIT"),
  ]) {
    const options = await fixture(t);
    await mutate(options.inputs[0], ".json", change);
    await assert.rejects(prepareNativeRelease(options), /layout\/license/);
  }
});

test("rejects incompatible macOS baselines and failed relocation probes", async (t) => {
  for (const suffix of [".json", "-provenance.json"]) {
    const options = await fixture(t);
    const input = options.inputs[4];
    await mutate(input, suffix, (value) =>
      suffix === ".json"
        ? (value.minimumOsVersion = "15.0")
        : (value.verification.result = "failed"),
    );
    await assert.rejects(prepareNativeRelease(options), /reviewed selection/);
  }
});

test("requires the complete dependency source set and matching inventories", async (t) => {
  for (const change of [
    (p) => (p.dependencies = []),
    (p) => (p.dependencies[0].sha256 = "a".repeat(64)),
  ]) {
    const options = await fixture(t);
    await mutate(options.inputs[4], "-provenance.json", change);
    await assert.rejects(
      prepareNativeRelease(options),
      /dependency|Dependency/,
    );
  }
});

test("rejects missing or substituted dependency archive bytes", async (t) => {
  for (const missing of [true, false]) {
    const options = await fixture(t);
    const file = path.join(
      options.inputs[4].directory,
      "php-dependency-crypto.tar.gz",
    );
    if (missing) await rm(file);
    else await writeFile(file, "corrupt-source");
    await assert.rejects(
      prepareNativeRelease(options),
      /Missing\/corrupt dependency/,
    );
  }
});

test("binds dependency identity and licenses to the separately reviewed pins", async (t) => {
  for (const key of ["version", "url", "license", "sha256"]) {
    const options = await fixture(t);
    const input = options.inputs[4];
    await mutate(
      input,
      "-provenance.json",
      (p) => (p.dependencies[0][key] = "substituted"),
    );
    const provenance = JSON.parse(
      await readFile(path.join(input.directory, input.id + "-provenance.json")),
    );
    await writeFile(
      path.join(input.directory, "php-dependency-provenance.json"),
      JSON.stringify(provenance.dependencies),
    );
    await assert.rejects(
      prepareNativeRelease(options),
      /Unreviewed dependency/,
    );
  }
});

test("requires verified Ubuntu library/source closure before staging Linux runtimes", async (t) => {
  for (const change of [
    (p) => delete p.linuxSources,
    (p) => (p.linuxSources.verification.result = "failed"),
    (p) => (p.linuxSources.distributionVersion = "24.04"),
    (p) => (p.linuxSources.libraries = []),
    (p) => (p.linuxSources.packages = []),
    (p) => (p.linuxSources.commonLicenses = []),
    (p) => (p.linuxSources.libraries[0].sourceVersion = "2.0"),
    (p) => p.linuxSources.packages[0].licenses.pop(),
  ]) {
    const options = await fixture(t);
    await mutate(options.inputs[0], "-provenance.json", change);
    await assert.rejects(
      prepareNativeRelease(options),
      /Ubuntu source closure/,
    );
    await assert.rejects(
      readFile(path.join(options.output, "release-manifest.json")),
      { code: "ENOENT" },
    );
  }
});

test("rejects substituted Linux source bundles", async (t) => {
  const options = await fixture(t);
  const input = options.inputs[0];
  const provenance = JSON.parse(
    await readFile(path.join(input.directory, input.id + "-provenance.json")),
  );
  await writeFile(
    path.join(input.directory, provenance.linuxSources.packages[0].bundle.file),
    "corrupt source bundle",
  );
  await assert.rejects(
    prepareNativeRelease(options),
    /checksum\/size mismatch/,
  );
});

test("rejects foreign Ubuntu source URLs, traversal and incomplete descriptors", async (t) => {
  for (const change of [
    (p) =>
      (p.linuxSources.packages[0].files[1].url =
        "https://foreign.test/source.tar.gz"),
    (p) => (p.linuxSources.libraries[0].path = "../../outside"),
    (p) => (p.linuxSources.packages[0].descriptor.sha256 = "a".repeat(64)),
    (p) => p.linuxSources.packages[0].binaryPackages.push("another:amd64"),
  ]) {
    const options = await fixture(t);
    await mutate(options.inputs[0], "-provenance.json", change);
    await assert.rejects(
      prepareNativeRelease(options),
      /Ubuntu source closure/,
    );
  }
});
