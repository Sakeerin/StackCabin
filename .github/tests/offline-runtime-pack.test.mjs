import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  buildOfflinePack,
  catalogFiles,
  runtimeReceiptFile,
} from "../scripts/offline-runtime-pack.mjs";
import { get, sha256 } from "../../scripts/catalog-lib.mjs";
import { verifyRuntimePack } from "../../scripts/windows-offline-manifest.mjs";

const workspace = path.resolve(import.meta.dirname, "../..");
const missing = (file) => assert.rejects(access(file), { code: "ENOENT" });
async function fixture(t) {
  await mkdir(path.join(workspace, "artifacts"), { recursive: true });
  const root = await mkdtemp(
      path.join(workspace, "artifacts", "offline-pack-tests-"),
    ),
    links = [];
  t.after(async () => {
    for (const link of links) await unlink(link).catch(() => {});
    assert.ok(
      path.relative(workspace, root).startsWith(`artifacts${path.sep}`),
    );
    await rm(root, { recursive: true, force: true });
  });
  const catalogDirectory = path.join(root, "runtime-catalog"),
    cache = path.join(root, "cache");
  await mkdir(catalogDirectory);
  await mkdir(cache);
  const data = new Map(),
    artifacts = [];
  for (const [platform, arch] of [
    ["windows", "x64"],
    ["linux", "x64"],
    ["macos", "x64"],
    ["macos", "arm64"],
  ]) {
    const bytes = Buffer.from(`fixture runtime ${platform}/${arch}`),
      url = `https://example.test/${platform}-${arch}.bin`;
    data.set(url, bytes);
    artifacts.push({
      id: `node-24.1.0-${platform}-${arch}`,
      component: "node",
      version: "24.1.0",
      platform,
      arch,
      url,
      sha256: sha256(bytes),
      size: bytes.length,
      archive: "file",
      stripComponents: 0,
      executables: { node: "node" },
      license: "test-fixture",
      sourceUrl: "https://example.test/source",
    });
  }
  artifacts.push({
    ...artifacts[0],
    id: "node-22.1.0-windows-x64",
    version: "22.1.0",
  });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const save = async () => {
    const bytes = Buffer.from(
      JSON.stringify(
        { schemaVersion: 1, generatedAt: "2026-01-01T00:00:00Z", artifacts },
        null,
        2,
      ) + "\n",
    );
    await writeFile(path.join(catalogDirectory, "catalog.json"), bytes);
    await writeFile(
      path.join(catalogDirectory, "catalog.sig"),
      sign(null, bytes, privateKey).toString("base64") + "\n",
    );
    await writeFile(
      path.join(catalogDirectory, "public-key.txt"),
      publicKey
        .export({ format: "der", type: "spki" })
        .subarray(-32)
        .toString("base64") + "\n",
    );
    await writeFile(
      path.join(catalogDirectory, "provenance.json"),
      JSON.stringify({ developmentKey: true, artifacts }) + "\n",
    );
  };
  await save();
  let calls = 0;
  const options = {
    catalogDirectory,
    cache,
    output: path.join(root, "ชุดใหม่ with spaces"),
    platform: "windows",
    arch: "x64",
    development: true,
    download: async (url) => {
      calls++;
      assert.ok(data.has(url));
      return data.get(url);
    },
  };
  const populate = async (layout = "content") => {
    for (const item of artifacts)
      await writeFile(
        path.join(cache, layout === "content" ? item.sha256 : sha256(item.url)),
        data.get(item.url),
      );
  };
  const controls = async () =>
    Object.fromEntries(
      await Promise.all(
        catalogFiles.map(async (name) => [
          name,
          await readFile(path.join(catalogDirectory, name)),
        ]),
      ),
    );
  return {
    root,
    artifacts,
    data,
    save,
    options,
    cache,
    catalogDirectory,
    populate,
    controls,
    calls: () => calls,
    async clean() {
      assert.deepEqual(
        (await readdir(root)).filter((name) =>
          name.startsWith(".stackcabin-offline-"),
        ),
        [],
      );
    },
    async link(source, destination) {
      await symlink(
        source,
        destination,
        process.platform === "win32" ? "junction" : "dir",
      );
      links.push(destination);
    },
  };
}

test("prepares a new signed runtime pack, deduplicates archives and writes a scoped receipt last", async (t) => {
  const f = await fixture(t),
    before = await f.controls();
  const result = await buildOfflinePack({
    ...f.options,
    onProgress: async (event) => {
      if (event.phase === "publishing") await missing(f.options.output);
    },
  });
  assert.equal(result.receipt.artifactCount, 2);
  assert.equal(result.receipt.archiveCount, 1);
  assert.equal(f.calls(), 1);
  assert.equal(result.receipt.productionApproved, false);
  assert.equal(result.receipt.files.length, 5);
  assert.deepEqual(await f.controls(), before);
  assert.ok((await readdir(f.options.output)).includes(runtimeReceiptFile));
  assert.equal(
    (await verifyRuntimePack(f.options.output, f.catalogDirectory))
      .runtimeCount,
    2,
  );
  await f.clean();
});

test("supports every certified target and rejects unsupported or empty targets without a pack", async (t) => {
  const f = await fixture(t);
  await f.populate();
  for (const [platform, arch] of [
    ["windows", "x64"],
    ["linux", "x64"],
    ["macos", "x64"],
    ["macos", "arm64"],
  ]) {
    const result = await buildOfflinePack({
      ...f.options,
      platform,
      arch,
      offline: true,
      output: path.join(f.root, `${platform}-${arch}`),
    });
    assert.equal(result.receipt.platform, platform);
    assert.equal(result.receipt.arch, arch);
  }
  for (const [platform, arch] of [
    ["windows", "arm64"],
    ["linux", "arm64"],
    ["unknown", "x64"],
  ])
    await assert.rejects(
      buildOfflinePack({ ...f.options, platform, arch }),
      /Unsupported/,
    );
  f.artifacts.splice(
    0,
    f.artifacts.length,
    ...f.artifacts.filter((item) => item.platform !== "windows"),
  );
  await f.save();
  await assert.rejects(buildOfflinePack(f.options), /No runtimes/);
  await missing(f.options.output);
  await f.clean();
});

test("uses both cache layouts without network calls or changing source cache bytes", async (t) => {
  for (const layout of ["content", "publisher"]) {
    const f = await fixture(t);
    await f.populate(layout);
    await buildOfflinePack({ ...f.options, offline: true });
    assert.equal(f.calls(), 0);
    const item = f.artifacts[0],
      name = layout === "content" ? item.sha256 : sha256(item.url);
    assert.deepEqual(
      await readFile(path.join(f.cache, name)),
      f.data.get(item.url),
    );
    await f.clean();
  }
});

test("offline cache misses, corrupt archives, wrong lengths and interrupted transfers never publish a pack", async (t) => {
  for (const mode of [
    "missing",
    "corrupt",
    "truncated",
    "oversized",
    "interrupted",
  ]) {
    const f = await fixture(t),
      item = f.artifacts[0],
      bytes = f.data.get(item.url);
    if (mode === "corrupt")
      await writeFile(
        path.join(f.cache, item.sha256),
        Buffer.alloc(bytes.length, 1),
      );
    const download = async () =>
      mode === "truncated"
        ? bytes.subarray(1)
        : mode === "oversized"
          ? Buffer.concat([bytes, bytes])
          : (async function* () {
              yield bytes.subarray(0, 4);
              throw new Error("interrupted fixture transfer");
            })();
    await assert.rejects(
      buildOfflinePack({ ...f.options, offline: mode === "missing", download }),
      /missing runtime|checksum mismatch|size mismatch|exceeds expected|interrupted/,
    );
    await missing(f.options.output);
    await f.clean();
  }
});

test("a known archive with legacy unknown size is verified by hash with its actual size in the receipt", async (t) => {
  const f = await fixture(t);
  for (const item of f.artifacts) item.size = 0;
  await f.save();
  const { receipt } = await buildOfflinePack(f.options);
  assert.equal(
    receipt.files.find((item) => item.file === f.artifacts[0].sha256).bytes,
    f.data.get(f.artifacts[0].url).length,
  );
});

test("conflicting or invalid signed sizes are rejected before any archive download", async (t) => {
  for (const mode of ["conflict", "invalid"]) {
    const f = await fixture(t);
    f.artifacts[mode === "conflict" ? 4 : 0].size =
      mode === "conflict" ? 999 : 9 * 1024 * 1024 * 1024;
    await f.save();
    await assert.rejects(
      buildOfflinePack(f.options),
      /Conflicting sizes|Invalid runtime archive size/,
    );
    assert.equal(f.calls(), 0);
    await missing(f.options.output);
    await f.clean();
  }
});

test("an existing completed or empty directory is never overwritten", async (t) => {
  const f = await fixture(t);
  await buildOfflinePack(f.options);
  const before = await readFile(
      path.join(f.options.output, runtimeReceiptFile),
    ),
    calls = f.calls();
  await assert.rejects(buildOfflinePack(f.options), /already exists/);
  assert.equal(f.calls(), calls);
  assert.deepEqual(
    await readFile(path.join(f.options.output, runtimeReceiptFile)),
    before,
  );
  const empty = path.join(f.root, "existing-empty");
  await mkdir(empty);
  await assert.rejects(
    buildOfflinePack({ ...f.options, output: empty }),
    /already exists/,
  );
  assert.deepEqual(await readdir(empty), []);
});

test("a directory created at publication time is preserved with its unrelated file", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    buildOfflinePack({
      ...f.options,
      onProgress: async (event) => {
        if (event.phase !== "publishing") return;
        await mkdir(f.options.output);
        await writeFile(path.join(f.options.output, "keep.txt"), "new owner");
      },
    }),
    /EEXIST/,
  );
  assert.equal(
    await readFile(path.join(f.options.output, "keep.txt"), "utf8"),
    "new owner",
  );
  await f.clean();
});

test("linked directories and linked/nonregular inputs are rejected without following them", async (t) => {
  for (const kind of ["parent", "catalog", "cache", "control", "archive"]) {
    const f = await fixture(t),
      destination = path.join(f.root, `linked-${kind}`);
    await f.link(f.cache, destination);
    let options = { ...f.options };
    if (kind === "parent") options.output = path.join(destination, "new-pack");
    if (kind === "catalog") options.catalogDirectory = destination;
    if (kind === "cache") options.cache = destination;
    if (kind === "control") {
      await unlink(path.join(f.catalogDirectory, "catalog.sig"));
      await f.link(f.cache, path.join(f.catalogDirectory, "catalog.sig"));
    }
    if (kind === "archive") {
      await f.link(
        f.catalogDirectory,
        path.join(f.cache, f.artifacts[0].sha256),
      );
    }
    await assert.rejects(
      buildOfflinePack(options),
      /real directories|regular pack input/,
    );
    await missing(f.options.output);
    await f.clean();
  }
});

test("output cannot overlap the trusted catalog or cache", async (t) => {
  const f = await fixture(t);
  for (const input of [f.cache, f.catalogDirectory])
    await assert.rejects(
      buildOfflinePack({ ...f.options, output: path.join(input, "new-pack") }),
      /overlaps/,
    );
  await f.clean();
});

test("invalid signatures and a development catalog in release mode leave no destination", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    buildOfflinePack({ ...f.options, development: false }),
    /development key/,
  );
  await writeFile(
    path.join(f.catalogDirectory, "catalog.sig"),
    Buffer.alloc(64).toString("base64") + "\n",
  );
  await assert.rejects(
    buildOfflinePack(f.options),
    /Invalid catalog signature/,
  );
  await missing(f.options.output);
  await f.clean();
});

test("changing the trusted source during a transfer aborts publication and preserves the external change", async (t) => {
  const f = await fixture(t),
    original = await readFile(path.join(f.catalogDirectory, "catalog.json"));
  await assert.rejects(
    buildOfflinePack({
      ...f.options,
      download: async (url) => {
        await writeFile(
          path.join(f.catalogDirectory, "catalog.json"),
          Buffer.concat([original, Buffer.from("\n")]),
        );
        return f.data.get(url);
      },
    }),
    /Trusted catalog changed/,
  );
  assert.equal(
    (await readFile(path.join(f.catalogDirectory, "catalog.json"))).length,
    original.length + 1,
  );
  await missing(f.options.output);
  await f.clean();
});

test("staged archive substitution is caught again when publishing, before a completion receipt exists", async (t) => {
  const f = await fixture(t);
  const second = Buffer.from("another archive");
  f.artifacts.push({
    ...f.artifacts[0],
    id: "tool-extra-windows-x64",
    url: "https://example.test/extra.bin",
    sha256: sha256(second),
    size: second.length,
  });
  await f.save();
  await assert.rejects(
    buildOfflinePack({
      ...f.options,
      download: async (url) => {
        if (url.endsWith("extra.bin")) {
          const stage = (await readdir(f.root)).find((name) =>
            name.startsWith(".stackcabin-offline-"),
          );
          await writeFile(
            path.join(f.root, stage, f.artifacts[0].sha256),
            Buffer.alloc(f.artifacts[0].size, 1),
          );
          return second;
        }
        return f.data.get(url);
      },
    }),
    /checksum mismatch/,
  );
  await missing(f.options.output);
  await f.clean();
});

test("cleanup retains an unexpected file created in the owned staging directory", async (t) => {
  const f = await fixture(t);
  let stage;
  await assert.rejects(
    buildOfflinePack({
      ...f.options,
      download: async () => {
        stage = (await readdir(f.root)).find((name) =>
          name.startsWith(".stackcabin-offline-"),
        );
        await writeFile(path.join(f.root, stage, "keep.txt"), "unrelated");
        throw new Error("download failed");
      },
    }),
    /download failed/,
  );
  assert.deepEqual(await readdir(path.join(f.root, stage)), ["keep.txt"]);
  await missing(f.options.output);
});

test("cancellation during a chunked transfer cleans owned partials and never writes a receipt", async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  await assert.rejects(
    buildOfflinePack({
      ...f.options,
      signal: controller.signal,
      download: async () =>
        (async function* () {
          yield Buffer.from("part");
          controller.abort(new Error("fixture cancellation"));
          yield Buffer.from("rest");
        })(),
    }),
    /fixture cancellation/,
  );
  await missing(f.options.output);
  await f.clean();
});

test("cached large inputs are copied and hashed across multiple chunks", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.alloc(512 * 1024 + 11, 3);
  for (const item of f.artifacts) {
    item.size = bytes.length;
    item.sha256 = sha256(bytes);
    f.data.set(item.url, bytes);
  }
  await f.save();
  await f.populate();
  const result = await buildOfflinePack({ ...f.options, offline: true });
  assert.equal(result.receipt.archiveCount, 1);
  assert.equal(result.receipt.files.at(-1).bytes, bytes.length);
  assert.equal(f.calls(), 0);
});

test("the optional receipt binds verified Windows bytes while legacy packs remain supported", async (t) => {
  const f = await fixture(t);
  await buildOfflinePack(f.options);
  const file = path.join(f.options.output, runtimeReceiptFile),
    original = await readFile(file);
  const record = JSON.parse(original);
  for (const change of [
    { completion: "starting" },
    { platform: "linux" },
    { artifactCount: 999 },
    { productionApproved: true },
    {
      files: record.files.map((item, i) =>
        i ? item : { ...item, sha256: "a".repeat(64) },
      ),
    },
  ]) {
    await writeFile(file, JSON.stringify({ ...record, ...change }));
    await assert.rejects(
      verifyRuntimePack(f.options.output, f.catalogDirectory),
      /completion receipt/,
    );
  }
  await writeFile(file, original);
  await writeFile(
    path.join(f.options.output, "README.txt"),
    "Windows installer packaging may replace this description.",
  );
  assert.equal(
    (await verifyRuntimePack(f.options.output, f.catalogDirectory))
      .runtimeCount,
    2,
  );
  await unlink(file);
  assert.equal(
    (await verifyRuntimePack(f.options.output, f.catalogDirectory))
      .runtimeCount,
    2,
  );
});

test("the shared download helper propagates cancellation to a stalled fetch", async (t) => {
  const controller = new AbortController();
  t.mock.method(
    globalThis,
    "fetch",
    async (url, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          { once: true },
        );
      }),
  );
  const pending = get("https://example.test/runtime", true, {
    signal: controller.signal,
  });
  controller.abort(new Error("stop download"));
  await assert.rejects(pending, /stop download/);
});

async function cliFixture(t) {
  const f = await fixture(t);
  await f.populate();
  for (const name of [
    "scripts/offline-pack.mjs",
    "scripts/catalog-lib.mjs",
    ".github/scripts/offline-runtime-pack.mjs",
  ]) {
    const file = path.join(f.root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await copyFile(path.join(workspace, name), file);
  }
  return {
    ...f,
    run: (args = []) =>
      spawnSync(
        process.execPath,
        [path.join(f.root, "scripts/offline-pack.mjs"), ...args],
        {
          env: {
            SystemRoot: process.env.SystemRoot,
            PATH: path.dirname(process.execPath),
          },
          encoding: "utf8",
          timeout: 30000,
        },
      ),
  };
}

test("the real CLI assembles from cache with Unicode paths and rejects subsequent overwrite", async (t) => {
  const f = await cliFixture(t),
    args = [
      "--platform=windows",
      "--dev",
      "--offline",
      `--cache=${f.cache}`,
      `--output=${f.options.output}`,
    ];
  const first = f.run(args);
  assert.equal(first.error, undefined);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(
    (await verifyRuntimePack(f.options.output, f.catalogDirectory))
      .runtimeCount,
    2,
  );
  const second = f.run(args);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /already exists/);
  await missing(path.join(f.root, ".local/catalog-dev-private.pem"));
});

test("the real CLI rejects implicit overwrite, duplicate flags and unsupported targets", async (t) => {
  const f = await cliFixture(t);
  for (const args of [
    ["--overwrite"],
    ["--platform=windows", "--platform=linux"],
    ["--platform=windows", "--arch=arm64"],
    [],
  ]) {
    const child = f.run(args);
    assert.equal(child.status, 1);
    assert.match(
      child.stderr,
      /Unknown or duplicate|Unsupported|Pass --platform/,
    );
  }
  await missing(f.options.output);
  await f.clean();
});
