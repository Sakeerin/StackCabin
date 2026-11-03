// Assemble reviewable release assets without publishing or accessing signing keys.
import { constants, createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { root } from "./catalog-lib.mjs";
import { verifyNativeStack } from "./native-stack-lib.mjs";

const targets = ["linux-x64", "macos-arm64", "macos-x64"];
const executables = {
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
const json = async (file) =>
  JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sortedObject = (value) =>
  Object.fromEntries(Object.entries(value).sort());

export function releaseBase(repository, tag) {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(
      repository || "",
    ) ||
    !/^native-[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(tag || "") ||
    tag.includes("..") ||
    tag.endsWith(".") ||
    tag.endsWith(".lock")
  )
    throw new Error(
      "Use an explicit owner/repository and immutable native-* release tag",
    );
  return `https://github.com/${repository}/releases/download/${tag}`;
}

export function releaseSelections(selections) {
  if (!same(Object.keys(selections.targets || {}).sort(), [...targets].sort()))
    throw new Error(
      "Release requires exactly the three supported Unix targets",
    );
  return targets.flatMap((target) => {
    const builds = selections.targets[target];
    if (
      !Array.isArray(builds) ||
      builds.length !== 4 ||
      !same(
        builds
          .map(
            (b) =>
              `${b.component}-${b.version
                .split(".")
                .slice(0, b.component === "postgres" ? 1 : 2)
                .join(".")}`,
          )
          .sort(),
        ["php-8.4", "php-8.5", "mariadb-12.3", "postgres-18"].sort(),
      )
    )
      throw new Error(`Incomplete native release matrix: ${target}`);
    return builds.map((build) => {
      if (
        !/^\d+\.\d+(?:\.\d+)?$/.test(build.version) ||
        !/^[1-9]\d*$/.test(String(build.run)) ||
        !/^[a-zA-Z0-9._-]+$/.test(build.artifact || "")
      )
        throw new Error("Invalid reviewed producer selection");
      const [platform, arch] = target.split("-");
      return {
        ...build,
        platform,
        arch,
        id: `${build.component}-${build.version}-${target}`,
      };
    });
  });
}

export function verifyProducer(run, build, repository) {
  if (
    String(run?.id) !== String(build.run) ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.event !== "workflow_dispatch" ||
    run.path !== ".github/workflows/native-runtime.yml" ||
    !/^[a-f0-9]{40}$/.test(run.head_sha || "") ||
    [run.repository?.full_name, run.head_repository?.full_name].some(
      (name) =>
        typeof name !== "string" ||
        name.toLowerCase() !== repository.toLowerCase(),
    )
  )
    throw new Error(
      `Expected a successful native producer from this repository: ${build.id}`,
    );
  return run.head_sha;
}

async function fingerprint(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Expected a regular asset file: ${file}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { size: info.size, sha256: hash.digest("hex") };
}

export async function prepareNativeRelease({
  inputs,
  selections,
  sources,
  dependencySources,
  repository,
  tag,
  output,
}) {
  const base = releaseBase(repository, tag);
  const builds = releaseSelections(selections);
  if (
    !Array.isArray(inputs) ||
    inputs.length !== builds.length ||
    new Set(inputs.map((i) => i.id)).size !== builds.length ||
    inputs.some((i) => !builds.some((b) => b.id === i.id))
  )
    throw new Error("Inputs must contain each reviewed runtime exactly once");
  const assets = new Map();
  const sourceInventory = new Map();
  const native = [];
  const producers = [];

  async function asset(file, name, expected) {
    if (!/^[a-zA-Z0-9._-]+$/.test(name))
      throw new Error("Unsafe release asset name");
    const actual = await fingerprint(file);
    if (
      expected &&
      (actual.sha256 !== expected.sha256 ||
        (expected.size !== undefined && actual.size !== expected.size))
    )
      throw new Error(`Release asset checksum/size mismatch: ${name}`);
    const previous = assets.get(name);
    if (
      previous &&
      (previous.sha256 !== actual.sha256 || previous.size !== actual.size)
    )
      throw new Error(`Immutable release asset collision: ${name}`);
    if (!previous) assets.set(name, { file, name, ...actual });
    return name;
  }
  async function sourceAsset(file, source, id) {
    const extension = /\.(tar\.gz|tar\.xz|tar\.bz2|tgz)$/.exec(file)?.[0];
    if (
      !extension ||
      !/^[a-f0-9]{64}$/.test(source.sha256 || "") ||
      !source.license ||
      !source.url?.startsWith("https://")
    )
      throw new Error(`Incomplete source/license metadata: ${id}`);
    const name = await asset(file, `source-${source.sha256}${extension}`, {
      sha256: source.sha256,
    });
    const key = `${name}:${source.name}:${source.version}`;
    const previous = sourceInventory.get(key);
    if (previous) previous.usedBy.push(id);
    else sourceInventory.set(key, { ...source, file: name, usedBy: [id] });
  }

  for (const build of builds) {
    const input = inputs.find((i) => i.id === build.id);
    const commit = verifyProducer(input.run, build, repository);
    const directory = await realpath(input.directory);
    for (const name of [
      `${build.id}.json`,
      `${build.id}-provenance.json`,
      `${build.id}-source.tar.gz`,
      `${build.id}.tar.gz`,
    ])
      if (
        !(await lstat(path.join(directory, name))).isFile() ||
        (await lstat(path.join(directory, name))).isSymbolicLink()
      )
        throw new Error(`Expected a regular asset file: ${name}`);
    const [metadata] = await verifyNativeStack(
      directory,
      build.platform,
      build.arch,
      [build],
      sources,
    );
    if (
      metadata.stripComponents !== 1 ||
      metadata.license !== licenses[build.component] ||
      !same(
        sortedObject(metadata.executables || {}),
        sortedObject(executables[build.component]),
      )
    )
      throw new Error(`Unexpected executable layout/license: ${build.id}`);
    await asset(
      path.join(directory, `${build.id}.tar.gz`),
      `${build.id}.tar.gz`,
      metadata,
    );
    await asset(path.join(directory, `${build.id}.json`), `${build.id}.json`);
    await asset(
      path.join(directory, `${build.id}-provenance.json`),
      `${build.id}-provenance.json`,
    );
    const source = sources.find(
      (s) => s.component === build.component && s.version === build.version,
    );
    await sourceAsset(
      path.join(directory, `${build.id}-source.tar.gz`),
      {
        name: build.component,
        version: build.version,
        license: metadata.license,
        url: source.sourceUrl,
        sha256: source.sourceSha256,
      },
      build.id,
    );
    const provenance = await json(
      path.join(directory, `${build.id}-provenance.json`),
    );
    const expected =
      build.platform === "macos" ? dependencySources[build.component] : [];
    if (
      !Array.isArray(expected) ||
      !Array.isArray(provenance.dependencies) ||
      !same(
        provenance.dependencies.map((d) => d.name).sort(),
        expected.map((d) => d.name).sort(),
      )
    )
      throw new Error(`Incomplete dependency source closure: ${build.id}`);
    if (expected.length) {
      const depFile = path.join(
        directory,
        `${build.component}-dependency-provenance.json`,
      );
      await asset(depFile, `${build.id}-dependencies.json`);
      if (!same(await json(depFile), provenance.dependencies))
        throw new Error(`Dependency provenance mismatch: ${build.id}`);
      const candidates = (
        await readdir(directory, { withFileTypes: true })
      ).filter(
        (entry) =>
          entry.name.startsWith(`${build.component}-dependency-`) &&
          /\.(tar\.gz|tar\.xz|tar\.bz2|tgz)$/.test(entry.name),
      );
      const available = [];
      for (const entry of candidates)
        available.push({
          file: path.join(directory, entry.name),
          ...(await fingerprint(path.join(directory, entry.name))),
        });
      for (const dependency of expected) {
        const claimed = provenance.dependencies.find(
          (d) => d.name === dependency.name,
        );
        if (
          ["name", "version", "license", "url", "sha256"].some(
            (key) => claimed[key] !== dependency[key],
          ) ||
          claimed.deploymentTarget !== "14.0"
        )
          throw new Error(
            `Unreviewed dependency source: ${build.id}/${dependency.name}`,
          );
        const archive = available.find((a) => a.sha256 === dependency.sha256);
        if (!archive)
          throw new Error(
            `Missing/corrupt dependency source: ${build.id}/${dependency.name}`,
          );
        await sourceAsset(archive.file, dependency, build.id);
      }
    }
    native.push({ ...metadata, url: `${base}/${build.id}.tar.gz` });
    producers.push({
      id: build.id,
      run: String(build.run),
      artifact: build.artifact,
      sourceCommit: commit,
    });
  }

  // Exclusive creation protects existing review folders. A failed copy never gets
  // a completion manifest; it also never replaces an existing destination.
  output = path.resolve(output);
  await mkdir(output);
  const files = [];
  for (const entry of [...assets.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const destination = path.join(output, entry.name);
    await copyFile(entry.file, destination, constants.COPYFILE_EXCL);
    const copied = await fingerprint(destination);
    if (copied.sha256 !== entry.sha256 || copied.size !== entry.size)
      throw new Error(`Copied release asset checksum mismatch: ${entry.name}`);
    files.push({ name: entry.name, ...copied });
  }
  const controls = {
    "native-artifacts.json": JSON.stringify(native, null, 2) + "\n",
    "source-inventory.json":
      JSON.stringify([...sourceInventory.values()], null, 2) + "\n",
    "RELEASE_REVIEW.txt":
      "Unpublished native runtime release candidate. No catalog was signed.\nReview component/bundled-library licenses and corresponding-source completeness,\ncertify clean baseline machines, publish immutable assets, verify hosted bytes,\nthen separately review and sign the production catalog.\nLinux system-library source/redistribution review remains required.\nOriginal build metadata retains its producer's future URL; native-artifacts.json\ncontains the candidate release URLs. This folder is not a release approval.\n",
  };
  for (const [name, bytes] of Object.entries(controls)) {
    const file = path.join(output, name);
    await writeFile(file, bytes, { flag: "wx" });
    files.push({ name, ...(await fingerprint(file)) });
  }
  const manifest = {
    schemaVersion: 1,
    repository,
    tag,
    published: false,
    catalogSigned: false,
    runtimeCount: native.length,
    producers,
    files,
  };
  const bytes = JSON.stringify(manifest, null, 2) + "\n";
  const checks = [
    ...files,
    {
      name: "release-manifest.json",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  ];
  await writeFile(
    path.join(output, "SHA256SUMS.txt"),
    checks
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => `${f.sha256}  ${f.name}\n`)
      .join(""),
    { flag: "wx" },
  );
  await writeFile(path.join(output, "release-manifest.json"), bytes, {
    flag: "wx",
  });
  return manifest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const separator = arg.indexOf("=");
      if (
        separator < 3 ||
        !["--input", "--output", "--repository", "--tag"].includes(
          arg.slice(0, separator),
        )
      )
        throw new Error(
          "Usage: node scripts/prepare-native-release.mjs --input=inputs.json --output=new-folder --repository=owner/repo --tag=native-unique-tag",
        );
      return [arg.slice(2, separator), arg.slice(separator + 1)];
    }),
  );
  if (["input", "output", "repository", "tag"].some((key) => !args[key]))
    throw new Error("All four release preparation arguments are required");
  const { sources } = await json(
    path.join(root, "runtime-catalog/source-archives.json"),
  );
  const { libraries } = await json(
    path.join(root, "runtime-catalog/php-macos-library-sources.json"),
  );
  const common = await json(
    path.join(root, ".github/native-release-sources.json"),
  );
  const pg = sources.find((s) => s.component === "postgres");
  const dependencySources = {
    php: [
      ...common.crypto,
      ...libraries,
      {
        name: "libpq",
        version: pg.version,
        license: "PostgreSQL",
        url: pg.sourceUrl,
        sha256: pg.sourceSha256,
      },
    ],
    mariadb: [...common.crypto, common.pcre2],
    postgres: common.crypto,
  };
  const manifest = await prepareNativeRelease({
    ...args,
    inputs: await json(path.resolve(args.input)),
    selections: await json(path.join(root, ".github/native-test-builds.json")),
    sources,
    dependencySources,
  });
  console.log(
    JSON.stringify({
      output: path.resolve(args.output),
      runtimeCount: manifest.runtimeCount,
      files: manifest.files.length + 2,
      published: false,
      catalogSigned: false,
    }),
  );
}
