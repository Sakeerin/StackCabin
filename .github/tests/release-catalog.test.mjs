import { test } from "node:test";
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { signingFixture } from "./fixtures/catalog-signing.mjs";
import { digest, jsonBytes, repository } from "./fixtures/native-release.mjs";
import { signCatalogProposal } from "../scripts/sign-catalog-proposal.mjs";
import {
  main,
  verifyReleaseCatalog,
} from "../scripts/verify-release-catalog.mjs";

const names = [
  "catalog.json",
  "catalog.sig",
  "public-key.txt",
  "provenance.json",
];
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const absent = async (file) => assert.rejects(access(file), { code: "ENOENT" });
async function fixture(t) {
  const f = await signingFixture(t);
  await signCatalogProposal(f.signing);
  const directory = path.join(f.root, "shipping-catalog");
  await mkdir(directory);
  for (const name of names)
    await copyFile(
      path.join(f.signing.output, name),
      path.join(directory, name),
    );
  const options = {
    directory,
    receipt: path.join(f.signing.output, "SIGNING_RECEIPT.json"),
    receiptSha256: digest(
      await readFile(path.join(f.signing.output, "SIGNING_RECEIPT.json")),
    ),
    publicKeySha256: f.signing.publicKeySha256,
    repository,
  };
  const rebind = async (mutate) => {
    const record = await readJson(options.receipt);
    for (const entry of record.files) {
      const bytes = await readFile(path.join(directory, entry.name));
      Object.assign(entry, { size: bytes.length, sha256: digest(bytes) });
    }
    mutate?.(record);
    const bytes = jsonBytes(record);
    await writeFile(options.receipt, bytes);
    options.receiptSha256 = digest(bytes);
  };
  const change = async (name, mutate) => {
    const value = await readJson(path.join(directory, name));
    mutate(value);
    await writeFile(path.join(directory, name), jsonBytes(value));
  };
  return { ...f, options, rebind, change };
}

test("admits the exact four signing outputs using independently retained receipt/key pins without changing files", async (t) => {
  const f = await fixture(t),
    before = new Map();
  for (const name of names)
    before.set(name, await readFile(path.join(f.options.directory, name)));
  const receipt = await readFile(f.options.receipt);
  const result = await verifyReleaseCatalog(f.options);
  assert.equal(result.verification, "release-catalog-integrity-passed");
  assert.equal(result.artifactCount, 44);
  assert.equal(result.privateKeyAccessed, false);
  assert.equal(result.productionApproved, false);
  assert.equal(result.files.length, 4);
  assert.equal(result.catalogSha256, digest(before.get("catalog.json")));
  for (const [name, bytes] of before)
    assert.deepEqual(
      await readFile(path.join(f.options.directory, name)),
      bytes,
    );
  assert.deepEqual(await readFile(f.options.receipt), receipt);
});

test("separate receipt and production-key pins cannot be inferred from self-reported flags", async (t) => {
  const f = await fixture(t);
  for (const change of [
    { receiptSha256: undefined },
    { publicKeySha256: undefined },
    { receiptSha256: "0".repeat(64) },
    { publicKeySha256: "0".repeat(64) },
    {
      publicKeySha256:
        "203a1d0ff09c35d787e568a4cc4e746437454cf075a179960cfbb378597820d0",
    },
  ])
    await assert.rejects(
      verifyReleaseCatalog({ ...f.options, ...change }),
      /retained|hash mismatch|identity|development signing/,
    );
  const held = f.options.receiptSha256;
  await f.rebind((record) => (record.signedAt = "2026-01-01T00:00:00Z"));
  await assert.rejects(
    verifyReleaseCatalog({ ...f.options, receiptSha256: held }),
    /Retained signing-receipt hash mismatch/,
  );
});

test("mixing or altering any signed output fails even when catalog IDs and versions look unchanged", async (t) => {
  for (const name of names) {
    const f = await fixture(t);
    await writeFile(path.join(f.options.directory, name), "substituted bytes");
    await assert.rejects(
      verifyReleaseCatalog(f.options),
      /differs from the retained receipt/,
    );
  }
});

test("the original development key remains blocked with a false marker and alternate key-file whitespace", async (t) => {
  const f = await fixture(t);
  await f.change("provenance.json", (value) => (value.developmentKey = false));
  // Public development identity only: no development private key is needed.
  // Whitespace cannot disguise it, even after the shipping trust root rotates.
  const keyFile = path.join(f.options.directory, "public-key.txt");
  const raw = "O1CuQ0pYRXDiwMiKBJw6220HqbOycH/l5KLyQb5aFn0=";
  assert.equal(
    digest(Buffer.from(raw + "\n")),
    "203a1d0ff09c35d787e568a4cc4e746437454cf075a179960cfbb378597820d0",
  );
  await writeFile(keyFile, raw + "\r\n");
  f.options.publicKeySha256 = digest(await readFile(keyFile));
  await f.rebind((record) => {
    record.publicKeySha256 = f.options.publicKeySha256;
  });
  await assert.rejects(
    verifyReleaseCatalog(f.options),
    /known development Ed25519 signing identity/,
  );
});

test("updating receipt hashes cannot make an invalid signature or noncanonical public key acceptable", async (t) => {
  for (const mode of ["signature", "key-encoding"]) {
    const f = await fixture(t);
    if (mode === "signature")
      await writeFile(
        path.join(f.options.directory, "catalog.sig"),
        Buffer.alloc(64).toString("base64") + "\n",
      );
    else {
      const file = path.join(f.options.directory, "public-key.txt");
      await writeFile(file, (await readFile(file, "utf8")).trim() + "\r\n");
      f.options.publicKeySha256 = digest(await readFile(file));
    }
    await f.rebind(
      (record) => (record.publicKeySha256 = f.options.publicKeySha256),
    );
    await assert.rejects(
      verifyReleaseCatalog(f.options),
      /Invalid production catalog signature|canonical reviewed public-key/,
    );
  }
});

test("provenance must remain the exact signing output with an explicit production-key marker and matching inventory", async (t) => {
  for (const mutate of [
    (value) => delete value.developmentKey,
    (value) => (value.developmentKey = true),
    (value) => (value.handoffSha256 = "0".repeat(64)),
    (value) => value.artifacts.pop(),
  ]) {
    const f = await fixture(t);
    await f.change("provenance.json", mutate);
    await f.rebind();
    await assert.rejects(verifyReleaseCatalog(f.options), /provenance/);
  }
});

test("a valid signature cannot admit incomplete targets, unsafe executable paths or macOS 15-only runtimes", async (t) => {
  for (const mutate of [
    (value) =>
      (value.artifacts = value.artifacts.filter(
        (item) =>
          !(
            item.platform === "linux" &&
            item.component === "php" &&
            item.version.startsWith("8.5.")
          ),
      )),
    (value) => (value.artifacts[0].executables.pnpm = "../escape"),
    (value) =>
      (value.artifacts.find(
        (item) => item.platform === "macos" && item.component === "php",
      ).minimumOsVersion = "15.0"),
  ]) {
    const f = await fixture(t);
    await f.change("catalog.json", mutate);
    const bytes = await readFile(
      path.join(f.options.directory, "catalog.json"),
    );
    await writeFile(
      path.join(f.options.directory, "catalog.sig"),
      sign(null, bytes, f.key).toString("base64") + "\n",
    );
    await f.rebind((record) => (record.catalogSha256 = digest(bytes)));
    await assert.rejects(
      verifyReleaseCatalog(f.options),
      /Incomplete catalog matrix|artifact metadata|macOS 14.0/,
    );
  }
});

test("receipt repository, review scope, counts, duplicate names and path aliases cannot authorize packaging", async (t) => {
  for (const mutate of [
    (record) => (record.repository = "other/repository"),
    (record) => (record.scope = "production-approved"),
    (record) => record.artifactCount--,
    (record) => (record.files[0] = record.files[1]),
    (record) => (record.files[0].name = "../outside"),
    (record) => (record.handoffSha256 = "not-a-pin"),
  ]) {
    const f = await fixture(t);
    await f.rebind(mutate);
    await assert.rejects(
      verifyReleaseCatalog(f.options),
      /receipt|artifact count/,
    );
  }
});

test("only known regular catalog resources are admitted and their actual hashes are retained", async (t) => {
  const f = await fixture(t);
  await writeFile(
    path.join(f.options.directory, "windows-prerequisites.json"),
    jsonBytes({ fixture: true }),
  );
  const result = await verifyReleaseCatalog(f.options);
  assert.equal(result.files.length, 5);
  assert.equal(
    result.files.find((item) => item.name === "windows-prerequisites.json")
      .sha256,
    digest(jsonBytes({ fixture: true })),
  );
  await writeFile(
    path.join(f.options.directory, "secret.pem"),
    "not a real private key",
  );
  await assert.rejects(
    verifyReleaseCatalog(f.options),
    /unrecognized resources/,
  );
});

test("linked catalogs/resources and receipts inside shipping resources are rejected", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    verifyReleaseCatalog({
      ...f.options,
      receipt: path.join(f.options.directory, "SIGNING_RECEIPT.json"),
    }),
    /outside shipping catalog/,
  );
  const link = path.join(f.root, "linked-catalog");
  await symlink(
    f.options.directory,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    verifyReleaseCatalog({ ...f.options, directory: link }),
    /real directory/,
  );
  // A linked directory with a known resource name must not be followed.
  const resource = path.join(f.options.directory, "windows-prerequisites.json");
  await symlink(
    f.options.directory,
    resource,
    process.platform === "win32" ? "junction" : "dir",
  );
  try {
    await assert.rejects(verifyReleaseCatalog(f.options), /bounded regular/);
  } finally {
    await unlink(resource);
  }
});

test("CLI report is created only after success, outside inputs, and never replaces an existing report", async (t) => {
  const f = await fixture(t),
    report = path.join(f.root, "verification.json");
  const args = Object.entries({
    directory: f.options.directory,
    receipt: f.options.receipt,
    "receipt-sha256": f.options.receiptSha256,
    "public-key-sha256": f.options.publicKeySha256,
    repository,
  }).map(([name, value]) => `--${name}=${value}`);
  await main([...args, `--report=${report}`]);
  const before = await readFile(report);
  await assert.rejects(main([...args, `--report=${report}`]), {
    code: "EEXIST",
  });
  assert.deepEqual(await readFile(report), before);
  for (const destination of [
    path.join(f.options.directory, "report.json"),
    f.options.receipt,
  ])
    await assert.rejects(
      main([...args, `--report=${destination}`]),
      /outside catalog resources/,
    );
  await assert.rejects(
    main(args.filter((arg) => !arg.startsWith("--receipt-sha256="))),
    /Missing required/,
  );
  await assert.rejects(main([...args, "--dev"]), /Unknown or duplicate/);
  await assert.rejects(main([...args, args[0]]), /Unknown or duplicate/);
  const failure = path.join(f.root, "failure.json");
  await assert.rejects(
    main([
      ...args.map((arg) =>
        arg.startsWith("--receipt-sha256=")
          ? `--receipt-sha256=${"0".repeat(64)}`
          : arg,
      ),
      `--report=${failure}`,
    ]),
    /hash mismatch/,
  );
  await absent(failure);
});

test("real read-only CLI succeeds with no usable private key in its isolated environment", async (t) => {
  const f = await fixture(t);
  const args = Object.entries({
    directory: f.options.directory,
    receipt: f.options.receipt,
    "receipt-sha256": f.options.receiptSha256,
    "public-key-sha256": f.options.publicKeySha256,
    repository,
  }).map(([name, value]) => `--${name}=${value}`);
  const marker = "PRIVATE_KEY_MUST_NOT_BE_READ";
  const child = spawnSync(
    process.execPath,
    [
      path.resolve(
        import.meta.dirname,
        "../scripts/verify-release-catalog.mjs",
      ),
      ...args,
    ],
    {
      env: {
        SystemRoot: process.env.SystemRoot,
        PATH: path.dirname(process.execPath),
        STACKCABIN_CATALOG_PRIVATE_KEY: marker,
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
  assert.ok(!`${child.stdout}${child.stderr}`.includes(marker));
  assert.equal(JSON.parse(child.stdout).privateKeyAccessed, false);
  assert.deepEqual(
    (await readdir(f.options.directory)).sort(),
    [...names].sort(),
  );
});
