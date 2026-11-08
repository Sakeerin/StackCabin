import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  downloadRuntimeArchive,
  runtimeArchiveLimit,
} from "../scripts/runtime-archive-download.mjs";

const url = "https://example.test/runtime.tar.gz";
const payload = Buffer.from("verified streaming runtime");
const drain = async (stream) => {
  let bytes = 0;
  for await (const chunk of stream) bytes += chunk.byteLength;
  return bytes;
};
function response(
  chunks = [payload],
  { headers, status = 200, stall = false } = {},
) {
  let reads = 0,
    cancelled = false;
  const body = new ReadableStream(
    {
      pull(controller) {
        reads++;
        if (chunks.length) controller.enqueue(chunks.shift());
        else if (!stall) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const value = new Response(body, { headers, status });
  value.arrayBuffer = () => {
    throw new Error("Archive buffering is forbidden");
  };
  return { value, reads: () => reads, cancelled: () => cancelled };
}

test("fetches lazily, consumes one chunk at a time and cancels on early consumer return", async () => {
  const source = response([payload, payload]);
  let calls = 0,
    request;
  const stream = downloadRuntimeArchive(url, {
    fetchImpl: async (value, options) => {
      calls++;
      request = options;
      assert.equal(value, url);
      return source.value;
    },
  });
  assert.equal(calls, 0);
  assert.deepEqual((await stream.next()).value, payload);
  assert.equal(source.reads(), 1);
  assert.equal(request.redirect, "manual");
  assert.equal(request.credentials, "omit");
  assert.equal(request.headers["Accept-Encoding"], "identity");
  await stream.return();
  assert.equal(source.cancelled(), true);
  assert.equal(source.reads(), 1);
  assert.equal(request.signal.aborted, true);
});

test("accepts signed sizes and legacy unknown sizes with matching or chunked HTTP lengths", async () => {
  for (const expectedBytes of [0, payload.length])
    for (const declared of [false, true]) {
      const source = response([payload.subarray(0, 3), payload.subarray(3)], {
        headers: declared ? { "Content-Length": String(payload.length) } : {},
      });
      assert.equal(
        await drain(
          downloadRuntimeArchive(url, {
            expectedBytes,
            fetchImpl: async () => source.value,
          }),
        ),
        payload.length,
      );
    }
});

test("rejects malformed or incompatible length/encoding/status before consuming the archive", async () => {
  for (const headers of [
    { "Content-Length": "999" },
    { "Content-Length": "0" },
    { "Content-Length": "-1" },
    { "Content-Length": "bad" },
    { "Content-Length": "9007199254740993" },
    { "Content-Length": String(runtimeArchiveLimit + 1) },
    { "Content-Encoding": "gzip" },
  ]) {
    const source = response([payload], { headers });
    await assert.rejects(
      drain(
        downloadRuntimeArchive(url, {
          expectedBytes: payload.length,
          fetchImpl: async () => source.value,
        }),
      ),
      /content length|content encoding/,
    );
    assert.equal(source.reads(), 0);
    assert.equal(source.cancelled(), true);
  }
  for (const value of [
    new Response(null, { status: 204 }),
    new Response(null),
    new Response(null, { status: 500 }),
  ])
    await assert.rejects(
      drain(downloadRuntimeArchive(url, { fetchImpl: async () => value })),
      /HTTP|Missing runtime download body/,
    );
});

test("checks actual byte counts for truncated and oversized bodies even without HTTP lengths", async () => {
  for (const [bytes, headers] of [
    [payload.subarray(1), {}],
    [Buffer.concat([payload, Buffer.from("extra")]), {}],
    [payload.subarray(1), { "Content-Length": String(payload.length) }],
    [Buffer.alloc(0), {}],
  ])
    await assert.rejects(
      drain(
        downloadRuntimeArchive(url, {
          expectedBytes: payload.length,
          fetchImpl: async () => response([bytes], { headers }).value,
        }),
      ),
      /size mismatch|exceeds expected size/,
    );
  await assert.rejects(
    drain(
      downloadRuntimeArchive(url, {
        fetchImpl: async () =>
          response([payload, payload], {
            headers: { "Content-Length": String(payload.length) },
          }).value,
      }),
    ),
    /exceeds expected size/,
  );
});

test("enforces the hard archive limit when a legacy server omits its length", async () => {
  const chunk = Buffer.alloc(8 * 1024 * 1024);
  let emitted = 0,
    cancelled = false;
  const body = new ReadableStream(
    {
      pull(controller) {
        emitted++;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  await assert.rejects(
    drain(
      downloadRuntimeArchive(url, {
        fetchImpl: async () => new Response(body),
      }),
    ),
    /exceeds expected size/,
  );
  assert.equal(emitted, runtimeArchiveLimit / chunk.length + 1);
  assert.equal(cancelled, true);
});

test("validates size, deadline and HTTPS policy before issuing requests", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(payload);
  };
  for (const expectedBytes of [-1, 1.5, NaN, runtimeArchiveLimit + 1])
    await assert.rejects(
      drain(downloadRuntimeArchive(url, { expectedBytes, fetchImpl })),
      /Invalid runtime download/,
    );
  for (const timeoutMs of [0, -1, 1.5, 1_800_001])
    await assert.rejects(
      drain(downloadRuntimeArchive(url, { timeoutMs, fetchImpl })),
      /Invalid runtime download/,
    );
  for (const value of [
    "http://example.test/a",
    "https://user:password@example.test/a",
    "https://example.test/a#fragment",
  ])
    await assert.rejects(
      drain(downloadRuntimeArchive(value, { fetchImpl })),
      /require HTTPS/,
    );
  assert.equal(calls, 0);
});

test("follows bounded HTTPS CDN/relative redirects without credentials and cancels intermediate bodies", async () => {
  const visited = [],
    sources = [];
  assert.equal(
    await drain(
      downloadRuntimeArchive(url, {
        expectedBytes: payload.length,
        fetchImpl: async (value, options) => {
          visited.push(value);
          assert.equal(options.credentials, "omit");
          if (visited.length < 3) {
            const item = response([], {
              status: 302,
              headers: {
                Location:
                  visited.length === 1 ? "/next" : "https://cdn.test/file",
              },
            });
            sources.push(item);
            return item.value;
          }
          return new Response(payload);
        },
      }),
    ),
    payload.length,
  );
  assert.deepEqual(visited, [
    url,
    "https://example.test/next",
    "https://cdn.test/file",
  ]);
  assert.ok(sources.every((item) => item.cancelled() && item.reads() === 0));
});

test("rejects unsafe, missing, excessive and automatically followed redirects", async () => {
  for (const location of [
    "http://example.test/file",
    "https://secret@example.test/file",
    "https://example.test/file#fragment",
    null,
  ]) {
    let calls = 0;
    await assert.rejects(
      drain(
        downloadRuntimeArchive(url, {
          fetchImpl: async () => {
            calls++;
            return new Response(null, {
              status: 302,
              headers: location ? { Location: location } : {},
            });
          },
        }),
      ),
      /require HTTPS|Missing or excessive/,
    );
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(
    drain(
      downloadRuntimeArchive(url, {
        fetchImpl: async () => {
          calls++;
          return new Response(null, {
            status: 302,
            headers: { Location: url },
          });
        },
      }),
    ),
    /excessive/,
  );
  assert.equal(calls, 6);
  const followed = new Response(payload);
  Object.defineProperty(followed, "redirected", { value: true });
  await assert.rejects(
    drain(downloadRuntimeArchive(url, { fetchImpl: async () => followed })),
    /automatic runtime download redirect/,
  );
});

test("recovers an exact legacy PHP archive once on 404/410 and never changes the pinned version", async () => {
  const php =
    "https://downloads.php.net/~windows/releases/php-8.5.0-nts-Win32-vs17-x64.zip";
  for (const status of [404, 410]) {
    const visited = [];
    assert.equal(
      await drain(
        downloadRuntimeArchive(php, {
          fetchImpl: async (value) => {
            visited.push(value);
            return visited.length === 1
              ? new Response(null, { status })
              : new Response(payload);
          },
        }),
      ),
      payload.length,
    );
    assert.deepEqual(visited, [
      php,
      php.replace("/releases/", "/releases/archives/"),
    ]);
  }
  for (const [value, status, count] of [
    [php, 404, 2],
    [php, 500, 1],
    [url, 404, 1],
    [php + "?version=latest", 404, 1],
  ]) {
    let calls = 0;
    await assert.rejects(
      drain(
        downloadRuntimeArchive(value, {
          fetchImpl: async () => {
            calls++;
            return new Response(null, { status });
          },
        }),
      ),
      /HTTP/,
    );
    assert.equal(calls, count);
  }
});

test("cancellation covers pre-aborted requests and fetch implementations that ignore signals", async () => {
  const stopped = new AbortController();
  stopped.abort(new Error("user cancelled"));
  let calls = 0;
  await assert.rejects(
    drain(
      downloadRuntimeArchive(url, {
        signal: stopped.signal,
        fetchImpl: async () => {
          calls++;
          return new Response(payload);
        },
      }),
    ),
    /user cancelled/,
  );
  assert.equal(calls, 0);
  const controller = new AbortController();
  const pending = drain(
    downloadRuntimeArchive(url, {
      signal: controller.signal,
      fetchImpl: () => new Promise(() => {}),
    }),
  );
  controller.abort(new Error("user cancelled"));
  await assert.rejects(pending, /user cancelled/);
});

test("deadlines cover stalled headers and bodies without waiting for cancellation cleanup", async () => {
  await assert.rejects(
    drain(
      downloadRuntimeArchive(url, {
        timeoutMs: 25,
        fetchImpl: () => new Promise(() => {}),
      }),
    ),
    /deadline exceeded/,
  );
  let cancelled = false;
  const body = new ReadableStream({
    pull() {},
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    },
  });
  await assert.rejects(
    drain(
      downloadRuntimeArchive(url, {
        timeoutMs: 25,
        fetchImpl: async () => new Response(body),
      }),
    ),
    /deadline exceeded/,
  );
  assert.equal(cancelled, true);
});

test("cleans a response arriving after cancellation and propagates mid-body transport errors", async () => {
  const controller = new AbortController();
  let resolve, ready;
  const started = new Promise((done) => {
    ready = done;
  });
  const pending = drain(
    downloadRuntimeArchive(url, {
      signal: controller.signal,
      fetchImpl: () => {
        ready();
        return new Promise((done) => {
          resolve = done;
        });
      },
    }),
  );
  await started;
  controller.abort(new Error("cancel late headers"));
  await assert.rejects(pending, /cancel late headers/);
  const late = response();
  resolve(late.value);
  await new Promise((done) => setImmediate(done));
  assert.equal(late.cancelled(), true);
  const broken = new ReadableStream({
    pull(control) {
      control.error(new Error("connection lost"));
    },
  });
  await assert.rejects(
    drain(
      downloadRuntimeArchive(url, {
        fetchImpl: async () => new Response(broken),
      }),
    ),
    /connection lost/,
  );
});

test("a 384 MiB synthetic archive stays bounded in an isolated low-heap process", () => {
  const moduleUrl = new URL(
    "../scripts/runtime-archive-download.mjs",
    import.meta.url,
  ).href;
  const script = `
    import assert from 'node:assert/strict';
    import {downloadRuntimeArchive} from ${JSON.stringify(moduleUrl)};
    const size=384*1024*1024, chunk=Buffer.alloc(64*1024,17);
    let sent=0, received=0, reads=0, peak=0;
    const baseline=process.memoryUsage().rss;
    const body=new ReadableStream({pull(controller){
      if(sent===size){controller.close();return;}
      sent+=chunk.length;reads++;controller.enqueue(chunk);
    }},{highWaterMark:0});
    const response=new Response(body,{headers:{'Content-Length':String(size)}});
    response.arrayBuffer=()=>{throw Error('Buffering forbidden');};
    for await(const bytes of downloadRuntimeArchive('https://example.test/large',{
      expectedBytes:size,fetchImpl:async()=>response,
    })) {received+=bytes.length;if(reads%128===0)peak=Math.max(peak,process.memoryUsage().rss);}
    assert.equal(received,size);assert.equal(reads,size/chunk.length);
    assert.ok(peak-baseline<96*1024*1024, 'Archive-size memory growth');
    console.log(JSON.stringify({bytes:received,rssGrowth:peak-baseline,buffered:false}));
  `;
  const result = spawnSync(
    process.execPath,
    ["--max-old-space-size=32", "--input-type=module", "-e", script],
    {
      env: { SystemRoot: process.env.SystemRoot, PATH: "" },
      encoding: "utf8",
      timeout: 30000,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).bytes, 384 * 1024 * 1024);
});
