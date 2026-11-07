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
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  caDatedUrl,
  caLatestUrl,
  mergeCatalogUpdates,
  resolveCaArtifacts,
} from "../scripts/catalog-updates.mjs";
import { sha256, verifyCatalog } from "../../scripts/catalog-lib.mjs";

// Timestamp/PEM-shape fixtures only; these are not usable CA certificates.
const pem = (stamp = "Thu Nov  5 04:12:01 2026 GMT") =>
  Buffer.from(
    `## Bundle of CA Root Certificates\n## Certificate data from Mozilla as of: ${stamp}\n-----BEGIN CERTIFICATE-----\nZml4dHVyZSBvbmx5\n-----END CERTIFICATE-----\n`,
  );
const oldPem = () => pem("Tue Oct 20 13:32:40 2026 GMT");
async function records(bytes = pem(), historical = []) {
  return resolveCaArtifacts({
    fetchLatest: async () => bytes,
    fetchDated: async () => Buffer.from(bytes),
    historical,
  });
}

test("merging preserves every old field, keeps newly resolved defaults first, and leaves inputs unchanged", async () => {
  const historical = await records(oldPem());
  historical[0].reviewed = { nested: ["retain unknown metadata"] };
  const additions = await records();
  const before = JSON.stringify({ historical, additions });
  const merged = mergeCatalogUpdates(historical, [
    ...additions,
    structuredClone(historical[0]),
  ]);
  assert.deepEqual(merged, [...additions, ...historical]);
  assert.equal(JSON.stringify({ historical, additions }), before);
});

test("the same checksum cannot authorize URL, executable, extraction, source or other metadata changes", async () => {
  const [original] = await records();
  for (const change of [
    { url: "https://example.test/substitution" },
    { executables: { cacert: "../escape" } },
    { size: original.size + 1 },
    { stripComponents: 1 },
    { archive: "zip" },
    { license: "different" },
    { sourceUrl: "https://example.test/source" },
    { minimumOsVersion: "15.0" },
    { future: { flag: true } },
    { component: "node" },
    { sha256: "a".repeat(64) },
  ])
    assert.throws(
      () => mergeCatalogUpdates([original], [{ ...original, ...change }]),
      /immutable runtime metadata/,
    );
});

test("duplicate IDs and invalid artifact identities/integrity fail before merge", async () => {
  const [record] = await records();
  for (const [historical, resolved] of [
    [[record, record], []],
    [[], [record, record]],
  ])
    assert.throws(() => mergeCatalogUpdates(historical, resolved), /Duplicate/);
  for (const value of [
    null,
    [],
    { ...record, id: 1 },
    { ...record, id: "../escape" },
    { ...record, sha256: "bad" },
    { ...record, url: "http://example.test/file" },
  ])
    assert.throws(() => mergeCatalogUpdates([], [value]), /Invalid/);
  assert.throws(
    () => mergeCatalogUpdates({}, []),
    /Invalid historical artifact list/,
  );
});

test("CA conversion dates resolve in UTC including padded days and CRLF", () => {
  for (const bytes of [
    pem(),
    pem("Thu Nov 05 04:12:01 2026 GMT"),
    Buffer.from(pem().toString().replaceAll("\n", "\r\n")),
  ])
    assert.equal(caDatedUrl(bytes), "https://curl.se/ca/cacert-2026-11-05.pem");
  assert.equal(
    caDatedUrl(oldPem()),
    "https://curl.se/ca/cacert-2026-10-20.pem",
  );
});

test("missing, ambiguous, impossible or non-PEM conversion input cannot choose an archive", () => {
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.alloc(1024 * 1024 + 1),
    Buffer.from([255]),
    pem("Mon Nov  5 04:12:01 2026 GMT"),
    pem("Thu Feb 30 04:12:01 2026 GMT"),
    pem("Thu Nov  5 24:12:01 2026 GMT"),
    pem("Thu Nov  5 04:12:01 2026 UTC"),
    Buffer.concat([pem(), pem()]),
    Buffer.from("<html>publisher unavailable</html>"),
    Buffer.from(
      pem().toString().replace("-----BEGIN CERTIFICATE-----", "missing"),
    ),
  ])
    assert.throws(() => caDatedUrl(bytes));
  assert.throws(() => caDatedUrl(pem().toString()));
});

test("new CA records use only the byte-identical official dated archive on all four targets", async () => {
  const requests = [];
  const resolved = await resolveCaArtifacts({
    fetchLatest: async (url) => {
      requests.push(url);
      return pem();
    },
    fetchDated: async (url) => {
      requests.push(url);
      return pem();
    },
  });
  assert.deepEqual(requests, [
    caLatestUrl,
    "https://curl.se/ca/cacert-2026-11-05.pem",
  ]);
  assert.deepEqual(
    resolved.map(({ platform, arch }) => [platform, arch]),
    [
      ["windows", "x64"],
      ["macos", "x64"],
      ["macos", "arm64"],
      ["linux", "x64"],
    ],
  );
  for (const item of resolved) {
    assert.equal(item.sha256, sha256(pem()));
    assert.equal(item.size, pem().length);
    assert.equal(item.url, requests[1]);
    assert.equal(item.archive, "file");
    assert.equal(item.version, sha256(pem()).slice(0, 12));
  }
});

test("changed, truncated or missing historical bytes cannot produce CA metadata", async () => {
  for (const dated of [
    Buffer.from(pem().toString().replace("Zml4", "YmFk")),
    pem().subarray(1),
    oldPem(),
    "not bytes",
  ])
    await assert.rejects(
      resolveCaArtifacts({
        fetchLatest: async () => pem(),
        fetchDated: async () => dated,
      }),
      /differs/,
    );
  for (const mode of ["latest", "dated"])
    await assert.rejects(
      resolveCaArtifacts({
        fetchLatest: async () => {
          if (mode === "latest") throw new Error("503 latest");
          return pem();
        },
        fetchDated: async () => {
          throw new Error("404 dated");
        },
      }),
      mode === "latest" ? /503 latest/ : /404 dated/,
    );
});

test("a legacy latest URL is preserved only when every other signed field agrees", async () => {
  const historical = (await records(oldPem())).map((item) => ({
    ...item,
    url: caLatestUrl,
  }));
  const resolved = await records(oldPem(), historical);
  assert.deepEqual(resolved, historical);
  assert.deepEqual(mergeCatalogUpdates(historical, resolved), historical);
  for (const change of [
    { executables: { cacert: "different.pem" } },
    { sourceUrl: "https://example.test/source" },
    { url: "https://example.test/ca.pem" },
    { extra: true },
  ]) {
    const changed = historical.map((item) => ({ ...item, ...change }));
    const recovered = await records(oldPem(), changed);
    assert.throws(
      () => mergeCatalogUpdates(changed, recovered),
      /immutable runtime metadata/,
    );
  }
});

test("discovery is fresh for each resolution while old records remain immutable", async () => {
  let current = oldPem(),
    calls = 0;
  const options = {
    fetchLatest: async () => {
      calls++;
      return current;
    },
    fetchDated: async () => Buffer.from(current),
  };
  const first = await resolveCaArtifacts(options);
  current = pem();
  const second = await resolveCaArtifacts({ ...options, historical: first });
  assert.equal(calls, 2);
  assert.equal(mergeCatalogUpdates(first, second).length, 8);
});

test("a late callback cannot mutate the captured discovery bytes into a replacement", async () => {
  const bytes = pem();
  await assert.rejects(
    resolveCaArtifacts({
      fetchLatest: async () => bytes,
      fetchDated: async () => {
        bytes[bytes.length - 2] ^= 1;
        return bytes;
      },
    }),
    /differs/,
  );
});

async function cliFixture(t, { latest = pem(), dated = latest } = {}) {
  const workspace = path.resolve(import.meta.dirname, "../..");
  await mkdir(path.join(workspace, "artifacts"), { recursive: true });
  const root = await mkdtemp(
    path.join(workspace, "artifacts", "catalog-refresh-tests-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "catalog จำลอง with spaces");
  await mkdir(path.join(directory, "scripts"), { recursive: true });
  await mkdir(path.join(directory, ".github/scripts"), { recursive: true });
  await mkdir(path.join(directory, "runtime-catalog"));
  await mkdir(path.join(directory, ".local/publisher-cache"), {
    recursive: true,
  });
  for (const name of [
    "scripts/build-catalog.mjs",
    "scripts/catalog-lib.mjs",
    ".github/scripts/catalog-updates.mjs",
  ])
    await copyFile(path.join(workspace, name), path.join(directory, name));
  const historical = (await records(oldPem())).map((item) => ({
    ...item,
    url: caLatestUrl,
  }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const bytes = Buffer.from(
    JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: "2026-01-01T00:00:00Z",
        artifacts: historical,
      },
      null,
      2,
    ) + "\n",
  );
  const controls = {
    "catalog.json": bytes,
    "catalog.sig": Buffer.from(
      sign(null, bytes, privateKey).toString("base64") + "\n",
    ),
    "public-key.txt": Buffer.from(
      publicKey
        .export({ format: "der", type: "spki" })
        .subarray(-32)
        .toString("base64") + "\n",
    ),
    "provenance.json": Buffer.from(
      JSON.stringify({ developmentKey: true, artifacts: historical }) + "\n",
    ),
  };
  for (const [name, data] of Object.entries(controls))
    await writeFile(path.join(directory, "runtime-catalog", name), data);
  // A stale latest-URL cache must never stand in for fresh publisher discovery.
  await writeFile(
    path.join(directory, ".local/publisher-cache", sha256(caLatestUrl)),
    oldPem(),
  );
  await writeFile(
    path.join(directory, "publisher.json"),
    JSON.stringify({
      latest: latest.toString("base64"),
      dated: dated.toString("base64"),
      datedUrl: caDatedUrl(latest),
    }),
  );
  await writeFile(
    path.join(directory, "mock-publisher.mjs"),
    `import {readFile,appendFile} from "node:fs/promises";
const config=JSON.parse(await readFile(new URL("./publisher.json",import.meta.url)));
globalThis.fetch=async url=>{await appendFile(new URL("./requests.jsonl",import.meta.url),JSON.stringify(url)+"\\n");
if(url!==${JSON.stringify(caLatestUrl)}&&url!==config.datedUrl)throw new Error("Unexpected fixture publisher request");
return new Response(Buffer.from(url===${JSON.stringify(caLatestUrl)}?config.latest:config.dated,"base64"));};\n`,
  );
  return {
    directory,
    historical,
    controls,
    privateKey,
    async extra(values) {
      const file = path.join(directory, "extra.json");
      await writeFile(file, JSON.stringify(values));
      return `--extra=${file}`;
    },
    run(extra = [], withKey = false) {
      const env = {
        SystemRoot: process.env.SystemRoot,
        PATH: path.dirname(process.execPath),
      };
      if (withKey)
        env.STACKCABIN_CATALOG_PRIVATE_KEY = privateKey.export({
          type: "pkcs8",
          format: "pem",
        });
      return spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(path.join(directory, "mock-publisher.mjs")).href,
          path.join(directory, "scripts/build-catalog.mjs"),
          "--components=cacert",
          "--dev",
          ...extra,
        ],
        { env, encoding: "utf8", timeout: 30000 },
      );
    },
    async unchanged() {
      for (const [name, data] of Object.entries(controls))
        assert.deepEqual(
          await readFile(path.join(directory, "runtime-catalog", name)),
          data,
        );
      await assert.rejects(
        access(path.join(directory, ".local/catalog-dev-private.pem")),
        { code: "ENOENT" },
      );
    },
  };
}

test("real build CLI bypasses a stale latest cache and signs new dated metadata using only an ephemeral fixture key", async (t) => {
  const f = await cliFixture(t),
    child = f.run([], true);
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.doesNotMatch(child.stdout + child.stderr, /BEGIN PRIVATE KEY/);
  const catalog = await verifyCatalog(
    path.join(f.directory, "runtime-catalog"),
  );
  assert.deepEqual(catalog.artifacts.slice(4), f.historical);
  assert.equal(catalog.artifacts.length, 8);
  assert.ok(
    catalog.artifacts
      .slice(0, 4)
      .every((item) => item.url === "https://curl.se/ca/cacert-2026-11-05.pem"),
  );
  const requests = (
    await readFile(path.join(f.directory, "requests.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(requests, [
    caLatestUrl,
    "https://curl.se/ca/cacert-2026-11-05.pem",
  ]);
});

test("real build CLI retains a signed legacy CA URL when resolving exactly the same bytes", async (t) => {
  const f = await cliFixture(t, { latest: oldPem() }),
    child = f.run([], true);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(
    (await verifyCatalog(path.join(f.directory, "runtime-catalog"))).artifacts,
    f.historical,
  );
});

test("real build CLI rejects same-checksum metadata replacement before creating a key or touching signed controls", async (t) => {
  for (const change of [
    { url: "https://example.test/replacement.pem" },
    { executables: { cacert: "../escape" } },
  ]) {
    const f = await cliFixture(t),
      child = f.run([await f.extra([{ ...f.historical[0], ...change }])]);
    assert.equal(child.status, 1);
    assert.match(child.stderr, /immutable runtime metadata/);
    await f.unchanged();
  }
});

test("real build CLI rejects duplicate additions and bad integrity metadata before key generation", async (t) => {
  for (const mode of ["duplicate", "badHash"]) {
    const f = await cliFixture(t),
      [next] = await records();
    if (mode === "badHash") {
      next.id = "new-invalid-runtime";
      next.sha256 = "not-a-hash";
    }
    const child = f.run([await f.extra([next])]);
    assert.equal(child.status, 1);
    assert.match(
      child.stderr,
      mode === "duplicate"
        ? /Duplicate resolved/
        : /Invalid resolved artifact integrity/,
    );
    await f.unchanged();
  }
});

test("real build CLI rejects a substituted dated archive and preserves every signed control without a key", async (t) => {
  const f = await cliFixture(t, { dated: oldPem() }),
    child = f.run();
  assert.equal(child.status, 1);
  assert.match(child.stderr, /dated CA bundle differs/);
  await f.unchanged();
});
