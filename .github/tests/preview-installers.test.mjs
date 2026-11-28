import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findPreviewInstallers,
  githubMetadata,
  parsePreviewArguments,
  previewTargets,
  verifyAvailablePreview,
} from "../scripts/preview-installers.mjs";

const repository = "Sakeerin/StackCabin";

test("retries transient metadata reads on the same endpoint with bounded delays", async () => {
  const endpoints = [],
    delays = [];
  const request = async (_command, args) => {
    endpoints.push(args.at(-1));
    const stderr = ["error connecting to api.github.com", "gh: (HTTP 503)"][
      endpoints.length - 1
    ];
    if (stderr) throw Object.assign(new Error(), { stderr });
    return { stdout: '{"ok":true}' };
  };
  assert.deepEqual(
    await githubMetadata("selected-run", request, (ms) => delays.push(ms)),
    { ok: true },
  );
  assert.deepEqual(endpoints, Array(3).fill("selected-run"));
  assert.deepEqual(delays, [1000, 2000]);
});

test("stops on authentication, rate limits and invalid JSON, and caps repeated transport failures", async () => {
  for (const [stderr, count] of [
    ["HTTP 403", 1],
    ["HTTP 429", 1],
    ["i/o timeout", 3],
    ["", 1],
  ]) {
    let calls = 0;
    const request = async () => {
      calls++;
      if (stderr) throw Object.assign(new Error(), { stderr });
      return { stdout: "invalid" };
    };
    await assert.rejects(
      githubMetadata("selected-run", request, async () => {}),
    );
    assert.equal(calls, count);
  }
});
const now = Date.parse("2026-11-15T04:00:00Z");
const options = { repository, runId: "123", now };
const run = (id = 123) => ({
  id,
  status: "completed",
  conclusion: "success",
  event: "workflow_dispatch",
  path: ".github/workflows/preview-installers.yml",
  head_sha: "a".repeat(40),
  head_branch: "main",
  repository: { id: 42, full_name: repository },
  head_repository: { id: 42, full_name: repository },
});
function artifacts(producer = run()) {
  return Object.values(previewTargets).map((name, index) => ({
    id: index + 200,
    name,
    expired: false,
    size_in_bytes: 15000,
    digest: `sha256:${String(index).repeat(64)}`,
    created_at: "2026-11-14T04:00:00Z",
    expires_at: "2026-11-21T04:00:00Z",
    workflow_run: {
      id: producer.id,
      head_sha: producer.head_sha,
      head_branch: "main",
      repository_id: 42,
      head_repository_id: 42,
    },
  }));
}
const available = (producer = run(), items = artifacts(producer), extra = {}) =>
  verifyAvailablePreview(producer, items, {
    ...options,
    runId: String(producer.id),
    ...extra,
  });
const mutate = (change) => {
  const items = artifacts();
  change(items[0]);
  return items;
};
const envelope = (items) => ({ total_count: items.length, artifacts: items });
const discovery = (request, extra = {}) =>
  findPreviewInstallers({ request, now: () => now, ...extra });

test("one verified main-branch producer supplies all four targets and exact ZIP identities", () => {
  const result = available();
  assert.equal(result.scope, "github-artifact-availability");
  assert.equal(result.contentVerified, false);
  assert.equal(result.sourceCommit, run().head_sha);
  assert.equal(result.checkedAt, new Date(now).toISOString());
  assert.deepEqual(
    result.artifacts.map((item) => item.target),
    Object.keys(previewTargets),
  );
  for (const [index, item] of result.artifacts.entries()) {
    assert.equal(item.archiveSha256, String(index).repeat(64));
    assert.equal(item.expiresAt, artifacts()[index].expires_at);
    assert.equal(
      item.url,
      `https://github.com/${repository}/actions/runs/123/artifacts/${index + 200}`,
    );
    assert.deepEqual(item.downloadCommand, [
      "gh",
      "run",
      "download",
      "123",
      "--repo",
      repository,
      "--name",
      item.artifactName,
      "--dir",
      `installers/${item.target}`,
    ]);
  }
});

test("single-target discovery accepts partial builds while all requires a complete producer", () => {
  for (const [index, target] of Object.keys(previewTargets).entries()) {
    const item = artifacts()[index];
    assert.equal(
      available(run(), [item], { target }).artifacts[0].target,
      target,
    );
    assert.throws(() => available(run(), [item]), /Missing or ambiguous/);
  }
  assert.throws(
    () => available(run(), artifacts(), { target: "__proto__" }),
    /Unknown preview target/,
  );
});

test("failed, pending, foreign, fork, wrong-workflow and non-main producers are rejected", () => {
  for (const change of [
    { status: "in_progress" },
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { event: "pull_request" },
    { path: ".github/workflows/qa-desktop.yml" },
    { head_sha: "A".repeat(40) },
    { head_branch: "feature" },
    { repository: { id: 42, full_name: "foreign/StackCabin" } },
    { head_repository: { id: 43, full_name: repository } },
    { repository: { full_name: repository } },
  ])
    assert.throws(() => available({ ...run(), ...change }));
  assert.throws(
    () => available(run(), artifacts(), { runId: "124" }),
    /run ID/,
  );
});

test("expired, deleted, duplicate and soon-expiring artifacts never look available", () => {
  for (const change of [
    (item) => {
      item.expired = true;
    },
    (item) => {
      delete item.expired;
    },
    (item) => {
      item.expires_at = "2026-11-15T03:59:59Z";
    },
    (item) => {
      item.expires_at = "2026-11-15T04:15:00Z";
    },
  ])
    assert.throws(() => available(run(), mutate(change)), /expired or expires/);
  assert.throws(() => available(run(), []), /Missing or ambiguous/);
  assert.throws(
    () => available(run(), [...artifacts(), artifacts()[0]]),
    /Missing or ambiguous/,
  );
  const justSafe = mutate((item) => {
    item.expires_at = "2026-11-15T04:15:01Z";
  });
  assert.equal(available(run(), justSafe).artifacts.length, 4);
});

test("malformed IDs, sizes, hashes and timestamps fail closed", () => {
  for (const change of [
    (item) => {
      item.id = "200";
    },
    (item) => {
      item.size_in_bytes = 0;
    },
    (item) => {
      item.size_in_bytes = 8 * 1024 ** 3 + 1;
    },
    (item) => {
      item.size_in_bytes = 1.5;
    },
    (item) => {
      item.digest = null;
    },
    (item) => {
      item.digest = `sha256:${"A".repeat(64)}`;
    },
    (item) => {
      item.expires_at = "invalid";
    },
    (item) => {
      item.expires_at = "2027-02-30T04:00:00Z";
    },
    (item) => {
      item.created_at = item.expires_at;
    },
  ])
    assert.throws(() => available(run(), mutate(change)));
  assert.throws(() => available(run(), null), /artifact list/);
  assert.throws(
    () => available(run(), artifacts(), { now: NaN }),
    /discovery time/,
  );
});

test("artifact source identity must match the exact selected run and repository IDs", () => {
  for (const change of [
    (item) => {
      delete item.workflow_run;
    },
    (item) => {
      item.workflow_run.id++;
    },
    (item) => {
      item.workflow_run.head_sha = "b".repeat(40);
    },
    (item) => {
      item.workflow_run.head_branch = "fork";
    },
    (item) => {
      item.workflow_run.repository_id++;
    },
    (item) => {
      item.workflow_run.head_repository_id++;
    },
  ])
    assert.throws(
      () => available(run(), mutate(change)),
      /producer does not match/,
    );
});

test("latest discovery skips expired and partial builds without mixing producer artifacts", async () => {
  const calls = [];
  const result = await discovery(async (endpoint) => {
    calls.push(endpoint);
    if (endpoint.includes("/workflows/"))
      return { workflow_runs: [run(125), run(124), run(123)] };
    if (endpoint.includes("/125/")) return envelope([]);
    if (endpoint.includes("/124/"))
      return envelope(artifacts(run(124)).slice(0, 3));
    return envelope(artifacts());
  });
  assert.equal(result.runId, "123");
  assert.equal(calls.length, 4);
  assert.match(
    calls[0],
    /status=success&event=workflow_dispatch&branch=main&per_page=20&page=1$/,
  );
});

test("explicit run selection never falls back and checks identity before fetching artifacts", async () => {
  const calls = [];
  await assert.rejects(
    discovery(
      async (endpoint) => {
        calls.push(endpoint);
        if (endpoint.endsWith("/123")) return run(124);
        throw new Error("Must not request artifacts");
      },
      { runId: "123" },
    ),
    /run ID/,
  );
  assert.equal(calls.length, 1);
  await assert.rejects(
    discovery(
      async (endpoint) => {
        calls.push(endpoint);
        return endpoint.endsWith("/123") ? run() : envelope([]);
      },
      { runId: "123" },
    ),
    /Missing or ambiguous/,
  );
  assert.ok(calls.every((endpoint) => !endpoint.includes("/workflows/")));
});

test("artifact pagination checks every page instead of assuming the first page is complete", async () => {
  const calls = [];
  const irrelevant = Array.from({ length: 100 }, (_, i) => ({
    name: `diagnostic-${i}`,
  }));
  const result = await discovery(
    async (endpoint) => {
      calls.push(endpoint);
      if (endpoint.endsWith("/123")) return run();
      return {
        total_count: 104,
        artifacts: endpoint.endsWith("page=1") ? irrelevant : artifacts(),
      };
    },
    { runId: "123" },
  );
  assert.equal(result.artifacts.length, 4);
  assert.equal(calls.length, 3);
  assert.match(calls[2], /per_page=100&page=2$/);
  await assert.rejects(
    discovery(
      async (endpoint) =>
        endpoint.endsWith("/123")
          ? run()
          : { total_count: 5, artifacts: artifacts() },
      { runId: "123" },
    ),
    /Incomplete GitHub/,
  );
});

test("workflow discovery follows pages and stops after sixty candidates with actionable evidence", async () => {
  let listCalls = 0;
  let artifactCalls = 0;
  await assert.rejects(
    discovery(async (endpoint) => {
      if (endpoint.includes("/workflows/")) {
        const page = ++listCalls;
        return {
          workflow_runs: Array.from({ length: 20 }, (_, i) =>
            run(1000 - page * 20 - i),
          ),
        };
      }
      artifactCalls++;
      return envelope([]);
    }),
    (error) => {
      assert.match(error.message, /latest 60.*workflow again/);
      assert.equal(error.rejectedRuns.length, 60);
      return true;
    },
  );
  assert.equal(listCalls, 3);
  assert.equal(artifactCalls, 60);
  listCalls = 0;
  const result = await discovery(async (endpoint) => {
    if (endpoint.includes("/workflows/"))
      return {
        workflow_runs:
          ++listCalls === 1
            ? Array.from({ length: 20 }, (_, i) => run(200 - i))
            : [run()],
      };
    return envelope(endpoint.includes("/123/") ? artifacts() : []);
  });
  assert.equal(result.runId, "123");
  assert.equal(listCalls, 2);
});

test("authentication and network failures stop discovery instead of selecting older builds", async () => {
  let calls = 0;
  await assert.rejects(
    discovery(async () => {
      if (++calls === 1) return { workflow_runs: [run(124), run()] };
      throw new Error("HTTP 403 sensitive diagnostic");
    }),
    (error) => {
      assert.match(error.message, /Cannot read GitHub metadata/);
      assert.doesNotMatch(error.message, /sensitive/);
      return true;
    },
  );
  assert.equal(calls, 2);
});

test("discovery rechecks the clock after requests and rejects expiration during lookup", async () => {
  const items = mutate((item) => {
    item.expires_at = "2026-11-15T04:16:00Z";
  });
  await assert.rejects(
    discovery(
      async (endpoint) => (endpoint.endsWith("/123") ? run() : envelope(items)),
      {
        runId: "123",
        now: () => now + 61_000,
      },
    ),
    /expired or expires/,
  );
});

test("CLI options reject unknown, empty, duplicate and injected values before requests", async () => {
  assert.deepEqual(
    parsePreviewArguments([
      "--target=windows-x64",
      "--run-id=123",
      `--repository=${repository}`,
    ]),
    {
      target: "windows-x64",
      runId: "123",
      repository,
    },
  );
  for (const args of [
    ["--target="],
    ["--download"],
    ["--run-id=123", "--run-id=124"],
    ["--target", "all"],
  ])
    assert.throws(() => parsePreviewArguments(args));
  for (const extra of [
    { repository: "../foreign/repo" },
    { repository: "https://github.com/owner/repo" },
    { target: "all&branch=foreign" },
    { runId: "123&per_page=1" },
    { runId: "00123" },
  ])
    await assert.rejects(
      discovery(() => {
        throw new Error("Must not request metadata");
      }, extra),
      /Invalid GitHub repository|Unknown preview target|numeric installer run ID/,
    );
});

test("invalid and unbounded metadata responses cannot produce a selection", async () => {
  await assert.rejects(
    discovery(async () => ({ workflow_runs: null })),
    /workflow response/,
  );
  for (const value of [
    {},
    { total_count: -1, artifacts: [] },
    { total_count: 1, artifacts: null },
  ])
    await assert.rejects(
      discovery(
        async (endpoint) => (endpoint.endsWith("/123") ? run() : value),
        { runId: "123" },
      ),
      /artifact response/,
    );
  let pages = 0;
  await assert.rejects(
    discovery(
      async (endpoint) => {
        if (endpoint.endsWith("/123")) return run();
        pages++;
        return {
          total_count: 1001,
          artifacts: Array.from({ length: 100 }, () => ({ name: "ignored" })),
        };
      },
      { runId: "123" },
    ),
    /exceeded 1,000/,
  );
  assert.equal(pages, 10);
});
