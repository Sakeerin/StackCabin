import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  main,
  verifyCandidate,
  verifyHostedAsset,
  verifyHostedCandidate,
} from "../scripts/verify-native-release.mjs";

import {
  fixture,
  digest,
  jsonBytes,
  repository,
  tag,
  base,
} from "./fixtures/native-release.mjs";

test("checks a pinned candidate without modifying it or claiming hosted verification", async (t) => {
  const f = await fixture(t);
  const before = await readdir(f.directory);
  const { report } = await verifyCandidate(f.directory, f.options);
  assert.equal(report.verification, "byte-integrity-passed");
  assert.equal(report.runtimeCount, 12);
  assert.equal(report.fileCount, before.length);
  assert.equal(report.checksumRecords, before.length - 1);
  assert.equal(report.hostedVerification.result, "not-requested");
  assert.equal(report.productionApproved, false);
  assert.deepEqual(await readdir(f.directory), before);
});

test("requires a separately retained manifest hash even if manifest and sums are replaced together", async (t) => {
  const f = await fixture(t);
  f.manifest.files[0].sha256 = "0".repeat(64);
  await f.save();
  await assert.rejects(
    verifyCandidate(f.directory, f.options),
    /Trusted manifest checksum/,
  );
  await assert.rejects(
    verifyCandidate(f.directory, { ...f.options, manifestSha256: undefined }),
    /separately retained/,
  );
});

test("rejects corrupt bytes, incomplete sums and unrecorded files", async (t) => {
  for (const mode of ["corrupt", "missing-sum", "extra"]) {
    const f = await fixture(t);
    if (mode === "corrupt")
      await writeFile(
        path.join(f.directory, "RELEASE_REVIEW.txt"),
        Buffer.alloc(f.files.get("RELEASE_REVIEW.txt").length),
      );
    if (mode === "missing-sum")
      await writeFile(path.join(f.directory, "SHA256SUMS.txt"), "");
    if (mode === "extra")
      await writeFile(path.join(f.directory, "unexpected.txt"), "extra");
    await assert.rejects(
      verifyCandidate(f.directory, f.options),
      /checksum|inventory|unrecorded/i,
    );
  }
});

test("rejects traversal, reserved control aliases and duplicate asset identities before reading assets", async (t) => {
  for (const name of ["../outside", "SHA256SUMS.TXT", "NUL.txt"]) {
    const f = await fixture(t);
    f.manifest.files[0].name = name;
    await assert.rejects(
      verifyCandidate(f.directory, await f.save()),
      /unsafe manifest/,
    );
  }
  const f = await fixture(t);
  f.manifest.files.push({ ...f.manifest.files[0] });
  await assert.rejects(
    verifyCandidate(f.directory, await f.save()),
    /duplicate/,
  );
});

test("rejects linked candidate directories", async (t) => {
  const f = await fixture(t);
  const link = path.join(f.root, "linked");
  await symlink(
    f.directory,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(verifyCandidate(link, f.options), /real directory/);
});

test("rejects a candidate for another repository/tag and malformed runtime matrix", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    verifyCandidate(f.directory, {
      ...f.options,
      repository: "other/repository",
    }),
    /manifest identity/,
  );
  await assert.rejects(
    verifyCandidate(f.directory, { ...f.options, tag: "native-other" }),
    /manifest identity/,
  );
  f.manifest.runtimeCount = 11;
  await assert.rejects(
    verifyCandidate(f.directory, await f.save()),
    /manifest identity/,
  );
});

test("binds catalog URLs and source references to the checked candidate", async (t) => {
  for (const mode of ["url", "source"]) {
    const f = await fixture(t);
    const name =
      mode === "url" ? "native-artifacts.json" : "source-inventory.json";
    if (mode === "url") f.runtimes[0].url = "https://example.com/other.tar.gz";
    else f.inventory[0].usedBy = ["foreign-runtime"];
    const bytes = jsonBytes(mode === "url" ? f.runtimes : f.inventory);
    await writeFile(path.join(f.directory, name), bytes);
    Object.assign(
      f.manifest.files.find((entry) => entry.name === name),
      { size: bytes.length, sha256: digest(bytes) },
    );
    await assert.rejects(
      verifyCandidate(f.directory, await f.save()),
      /inventory differs/,
    );
  }
});

test("CLI writes completion only outside the candidate and preserves existing reports", async (t) => {
  const f = await fixture(t);
  const args = [
    `--directory=${f.directory}`,
    `--repository=${repository}`,
    `--tag=${tag}`,
    `--manifest-sha256=${f.options.manifestSha256}`,
  ];
  const output = path.join(f.root, "verification.json");
  await main([...args, `--report=${output}`]);
  const before = await readFile(output);
  await assert.rejects(main([...args, `--report=${output}`]), /EEXIST/);
  assert.deepEqual(await readFile(output), before);
  await assert.rejects(
    main([...args, `--report=${path.join(f.directory, "report.json")}`]),
    /outside the candidate/,
  );
  await assert.rejects(
    main([...args, `--report=${output}`, "--unknown=1"]),
    /Unknown or duplicate/,
  );
});

const payload = Buffer.from("public asset payload");
const expected = {
  name: "source-fixture.tar.gz",
  size: payload.length,
  sha256: digest(payload),
};
const assetUrl = `${base}/${expected.name}`;

test("streams hosted bytes through HTTPS redirects without forwarding credentials", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1
      ? new Response(null, {
          status: 302,
          headers: {
            location:
              "https://release-assets.githubusercontent.com/asset?temporary=opaque",
          },
        })
      : new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(payload.subarray(0, 5));
              controller.enqueue(payload.subarray(5));
              controller.close();
            },
          }),
        );
  };
  assert.deepEqual(
    await verifyHostedAsset(assetUrl, expected, { fetchImpl }),
    expected,
  );
  assert.equal(calls.length, 2);
  for (const { options } of calls) {
    assert.equal(options.redirect, "manual");
    assert.equal(options.credentials, "omit");
    assert.deepEqual(options.headers, { "Accept-Encoding": "identity" });
  }
});

test("rejects HTTP downgrade, foreign hosts, URL credentials and redirect loops", async () => {
  for (const location of [
    "http://github.com/file",
    "https://example.com/file",
    "https://secret@github.com/file",
  ]) {
    let requests = 0;
    await assert.rejects(
      verifyHostedAsset(assetUrl, expected, {
        fetchImpl: async () => {
          requests++;
          return new Response(null, { status: 302, headers: { location } });
        },
      }),
      /HTTPS on GitHub/,
    );
    assert.equal(requests, 1);
  }
  await assert.rejects(
    verifyHostedAsset(assetUrl, expected, {
      fetchImpl: async () =>
        new Response(null, { status: 302, headers: { location: assetUrl } }),
    }),
    /excessive/,
  );
});

test("rejects missing assets, wrong length, compressed responses, truncation and substituted bytes", async () => {
  for (const response of [
    () => new Response(null, { status: 404 }),
    () => new Response(payload, { headers: { "Content-Length": "999" } }),
    () => new Response(payload, { headers: { "Content-Encoding": "gzip" } }),
    () => new Response(payload.subarray(0, payload.length - 1)),
    () => new Response(Buffer.alloc(payload.length)),
    () => new Response(Buffer.concat([payload, Buffer.from("extra")])),
  ])
    await assert.rejects(
      verifyHostedAsset(assetUrl, expected, {
        fetchImpl: async () => response(),
      }),
      /HTTP 404|length mismatch|checksum\/size mismatch|exceeds expected size/,
    );
});

test("cancellation and deadlines cover headers and stalled bodies", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    verifyHostedAsset(assetUrl, expected, {
      signal: controller.signal,
      fetchImpl: async () => {
        calls++;
        return new Response(payload);
      },
    }),
    /cancelled or timed out/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    verifyHostedAsset(assetUrl, expected, {
      timeoutMs: 25,
      fetchImpl: () => new Promise(() => {}),
    }),
    /cancelled or timed out/,
  );
  await assert.rejects(
    verifyHostedAsset(assetUrl, expected, {
      timeoutMs: 25,
      fetchImpl: async () => new Response(new ReadableStream({ start() {} })),
    }),
    /cancelled or timed out/,
  );
});

test("marks hosted completion only after every expected asset has passed", async (t) => {
  const f = await fixture(t);
  const candidate = await verifyCandidate(f.directory, f.options);
  const fetchImpl = async (url) =>
    new Response(
      await readFile(
        path.join(f.directory, new URL(url).pathname.split("/").at(-1)),
      ),
    );
  const passed = await verifyHostedCandidate(candidate, { fetchImpl });
  assert.equal(passed.hostedVerification.result, "passed");
  assert.equal(passed.hostedVerification.files, candidate.report.fileCount);
  assert.equal(passed.hostedVerification.bytes, candidate.report.payloadBytes);
  assert.equal(passed.productionApproved, false);
  let requests = 0;
  await assert.rejects(
    verifyHostedCandidate(candidate, {
      fetchImpl: async (url) =>
        ++requests === 2 ? new Response(null, { status: 404 }) : fetchImpl(url),
    }),
    /HTTP 404/,
  );
  assert.equal(requests, 2);
  assert.equal(candidate.report.hostedVerification.result, "not-requested");
});
