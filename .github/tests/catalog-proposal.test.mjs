import { test } from "node:test";
import assert from "node:assert/strict";
import {
  access,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { digest, jsonBytes } from "./fixtures/native-release.mjs";
import {
  main,
  mergeCatalog,
  prepareCatalogProposal,
} from "../scripts/prepare-catalog-proposal.mjs";

import { proposalFixture } from "./fixtures/catalog-proposal.mjs";

async function changeNative(f, mutate) {
  mutate(f.runtimes);
  const bytes = jsonBytes(f.runtimes);
  await writeFile(path.join(f.directory, "native-artifacts.json"), bytes);
  Object.assign(
    f.manifest.files.find((item) => item.name === "native-artifacts.json"),
    { size: bytes.length, sha256: digest(bytes) },
  );
  f.settings.manifestSha256 = (await f.save()).manifestSha256;
}

async function absent(file) {
  await assert.rejects(access(file), { code: "ENOENT" });
}

test("builds a complete unsigned proposal while preserving every signed base entry and candidate byte", async (t) => {
  const f = await proposalFixture(t);
  const before = new Map();
  for (const directory of [f.directory, f.settings.catalogDirectory])
    for (const name of await readdir(directory))
      before.set(
        path.join(directory, name),
        await readFile(path.join(directory, name)),
      );
  const report = await prepareCatalogProposal(f.settings);
  assert.equal(report.status, "review-only-awaiting-public-hosting");
  assert.equal(report.baseArtifacts, 32);
  assert.equal(report.proposedArtifacts, 44);
  assert.equal(report.addedIds.length, 12);
  assert.equal(report.hostedVerification.result, "not-requested");
  assert.equal(report.catalogSigned, false);
  assert.equal(report.productionApproved, false);
  const proposed = JSON.parse(
    await readFile(path.join(f.settings.output, "catalog.proposed.json")),
  );
  assert.deepEqual(proposed.artifacts.slice(0, 32), f.base.artifacts);
  for (const [name, bytes] of before)
    assert.deepEqual(await readFile(name), bytes);
  for (const entry of report.files) {
    const bytes = await readFile(path.join(f.settings.output, entry.name));
    assert.equal(bytes.length, entry.size);
    assert.equal(digest(bytes), entry.sha256);
  }
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(f.settings.output, "native-artifacts.json")),
    ),
    f.runtimes,
  );
  await absent(path.join(f.settings.output, "catalog.sig"));
  assert.equal(
    (await readdir(f.settings.output)).length,
    report.files.length + 1,
  );
});

test("trust requires a separately retained public key, even for a valid replacement catalog/signature pair", async (t) => {
  for (const publicKeySha256 of [undefined, "0".repeat(64)]) {
    const f = await proposalFixture(t);
    await assert.rejects(
      prepareCatalogProposal({ ...f.settings, publicKeySha256 }),
      /trusted public-key|trust root/,
    );
    await absent(f.settings.output);
  }
});

test("an altered base catalog or signature cannot enter a proposal", async (t) => {
  for (const name of ["catalog.json", "catalog.sig"]) {
    const f = await proposalFixture(t);
    await writeFile(
      path.join(f.settings.catalogDirectory, name),
      name.endsWith("json")
        ? jsonBytes({ ...f.base, generatedAt: "altered" })
        : Buffer.alloc(64).toString("base64"),
    );
    await assert.rejects(
      prepareCatalogProposal(f.settings),
      /Invalid base catalog signature/,
    );
    await absent(f.settings.output);
  }
});

test("existing IDs preserve all metadata including URL, executables and archive policy", async (t) => {
  for (const change of [
    (item) =>
      (item.url = item.url.replace(
        "native-verification-fixture",
        "native-replacement",
      )),
    (item) => (item.executables.php = "bin/different-php"),
    (item) => (item.stripComponents = 0),
  ]) {
    const f = await proposalFixture(t, (base, fixture) => {
      const item = structuredClone(fixture.runtimes[0]);
      change(item);
      base.artifacts.push(item);
    });
    await assert.rejects(
      prepareCatalogProposal(f.settings),
      /Immutable catalog ID/,
    );
    await absent(f.settings.output);
  }
  const f = await proposalFixture(t, (base, fixture) =>
    base.artifacts.push(structuredClone(fixture.runtimes[0])),
  );
  const result = await prepareCatalogProposal(f.settings);
  assert.equal(result.proposedArtifacts, 44);
  assert.equal(result.addedIds.length, 11);
  assert.deepEqual(result.unchangedIds, [f.runtimes[0].id]);
});

test("duplicate base/native IDs and incomplete Node/PHP target matrices are rejected", async (t) => {
  for (const change of [
    (base) => base.artifacts.push(base.artifacts[0]),
    (base) =>
      (base.artifacts = base.artifacts.filter(
        (item) =>
          !(
            item.platform === "linux" &&
            item.component === "node" &&
            item.version.startsWith("22.")
          ),
      )),
  ]) {
    const f = await proposalFixture(t, change);
    await assert.rejects(
      prepareCatalogProposal(f.settings),
      /Duplicate base|Incomplete catalog matrix/,
    );
    await absent(f.settings.output);
  }
  const f = await proposalFixture(t);
  assert.throws(
    () => mergeCatalog(f.base, [...f.runtimes, f.runtimes[0]]),
    /Duplicate native/,
  );
  assert.throws(
    () =>
      mergeCatalog(
        f.base,
        f.runtimes.filter(
          (item) =>
            !(item.platform === "linux" && item.version.startsWith("8.5.")),
        ),
      ),
    /Incomplete catalog matrix/,
  );
});

test("native executable contracts, safe paths and macOS baseline are checked before handoff", async (t) => {
  for (const change of [
    (items) => delete items[0].executables["php-fpm"],
    (items) => (items[0].executables.php = "../php"),
    (items) => (items[0].executables.php = "C:\\php.exe"),
    (items) => (items[0].executables.php = "bin/NUL.exe"),
    (items) => (items[0].sourceUrl = "http://example.test/source"),
    (items) =>
      delete items.find((item) => item.platform === "macos").minimumOsVersion,
    (items) =>
      (items.find((item) => item.platform === "macos").minimumOsVersion =
        "14.1"),
  ]) {
    const f = await proposalFixture(t);
    await changeNative(f, change);
    await assert.rejects(
      prepareCatalogProposal(f.settings),
      /executable contract|artifact metadata|macOS/,
    );
    await absent(f.settings.output);
  }
});

test("corrupt candidate controls cannot become catalog additions", async (t) => {
  const f = await proposalFixture(t);
  await writeFile(
    path.join(f.directory, "native-artifacts.json"),
    jsonBytes([]),
  );
  await assert.rejects(
    prepareCatalogProposal(f.settings),
    /size mismatch|checksum mismatch/,
  );
  await absent(f.settings.output);
});

test("proposal destinations cannot overlap inputs, replace existing output or follow linked directories", async (t) => {
  const f = await proposalFixture(t);
  for (const output of [
    path.join(f.directory, "nested"),
    f.settings.catalogDirectory,
    f.root,
  ])
    await assert.rejects(
      prepareCatalogProposal({ ...f.settings, output }),
      /separate from/,
    );
  await prepareCatalogProposal(f.settings);
  const before = await readFile(
    path.join(f.settings.output, "CATALOG_HANDOFF.json"),
  );
  await assert.rejects(prepareCatalogProposal(f.settings), /already exists/);
  assert.deepEqual(
    await readFile(path.join(f.settings.output, "CATALOG_HANDOFF.json")),
    before,
  );
  const link = path.join(f.root, "linked-base");
  await symlink(
    f.settings.catalogDirectory,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    prepareCatalogProposal({ ...f.settings, catalogDirectory: link }),
    /real directory/,
  );
});

test("hosted mode streams every asset before creating the unsigned handoff", async (t) => {
  const f = await proposalFixture(t);
  let calls = 0;
  const report = await prepareCatalogProposal({
    ...f.settings,
    hosted: true,
    transport: {
      fetchImpl: async (url, options) => {
        await absent(f.settings.output);
        assert.equal(options.credentials, "omit");
        assert.deepEqual(options.headers, { "Accept-Encoding": "identity" });
        calls++;
        return new Response(
          await readFile(
            path.join(f.directory, new URL(url).pathname.split("/").at(-1)),
          ),
        );
      },
    },
  });
  assert.equal(calls, (await readdir(f.directory)).length);
  assert.equal(report.hostedVerification.files, calls);
  assert.equal(report.status, "hosted-bytes-verified-awaiting-release-review");
  assert.equal(report.catalogSigned, false);
  assert.equal(report.productionApproved, false);
  assert.equal(report.remainingGates.length, 3);
});

test("a failed public source/archive check leaves no proposal, even after other assets passed", async (t) => {
  for (const mode of ["missing", "changed"]) {
    const f = await proposalFixture(t);
    let calls = 0;
    await assert.rejects(
      prepareCatalogProposal({
        ...f.settings,
        hosted: true,
        transport: {
          fetchImpl: async (url) => {
            calls++;
            const name = new URL(url).pathname.split("/").at(-1);
            if (name.startsWith("source-"))
              return new Response("changed", {
                status: mode === "missing" ? 404 : 200,
              });
            return new Response(await readFile(path.join(f.directory, name)));
          },
        },
      }),
      /HTTP 404|checksum\/size mismatch|exceeds expected size/,
    );
    assert.ok(calls > 1);
    await absent(f.settings.output);
  }
});

test("CLI requires explicit trust and rejects a saved hosted report as a substitute for fresh transport checks", async (t) => {
  const f = await proposalFixture(t);
  const args = Object.entries({
    directory: f.directory,
    repository: f.settings.repository,
    tag: f.settings.tag,
    "manifest-sha256": f.settings.manifestSha256,
    "catalog-directory": f.settings.catalogDirectory,
    "public-key-sha256": f.settings.publicKeySha256,
    output: f.settings.output,
  }).map(([key, value]) => `--${key}=${value}`);
  await assert.rejects(
    main(args.filter((arg) => !arg.startsWith("--public-key-sha256="))),
    /Missing required/,
  );
  await assert.rejects(
    main([...args, "--hosted-report=passed.json"]),
    /Unknown or duplicate/,
  );
  await assert.rejects(main([...args, args[0]]), /Unknown or duplicate/);
  assert.equal((await main(args)).proposedArtifacts, 44);
});
