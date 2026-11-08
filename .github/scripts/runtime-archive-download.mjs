import { phpArchiveUrl } from "../../scripts/catalog-lib.mjs";

export const runtimeArchiveLimit = 8 * 1024 * 1024 * 1024;
const deadline = 30 * 60 * 1000;
const redirects = new Set([301, 302, 303, 307, 308]);

function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error(
      "Runtime downloads require HTTPS without credentials or fragments",
    );
  return url;
}

function abortable(start, signal) {
  signal.throwIfAborted();
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = () => reject(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
  });
  const pending = Promise.resolve().then(() => {
    signal.throwIfAborted();
    return start();
  });
  return Promise.race([pending, aborted]).finally(() =>
    signal.removeEventListener("abort", listener),
  );
}

const cancel = (body) => {
  void body?.cancel().catch(() => {});
};

// Each yielded chunk is written and hashed by the pack builder before it asks
// for more. Never materialize an archive with arrayBuffer()/Buffer.concat().
export async function* downloadRuntimeArchive(
  value,
  { expectedBytes = 0, signal, fetchImpl = fetch, timeoutMs = deadline } = {},
) {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 0 ||
    expectedBytes > runtimeArchiveLimit ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > deadline
  )
    throw new Error("Invalid runtime download size or deadline");
  let url = httpsUrl(value);
  const historicalPhpUrl = phpArchiveUrl(url.href);
  const controller = new AbortController();
  const active = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(
    () => controller.abort(new Error("Runtime download deadline exceeded")),
    timeoutMs,
  );
  let response, reader;
  try {
    let followed = 0,
      recoveredPhp = false;
    while (true) {
      response = await abortable(async () => {
        const received = await fetchImpl(url.href, {
          redirect: "manual",
          credentials: "omit",
          headers: {
            "User-Agent": "StackCabin-offline-pack/0.1",
            "Accept-Encoding": "identity",
          },
          signal: active,
        });
        // Also dispose a response arriving after an already-cancelled request.
        if (active.aborted) {
          cancel(received.body);
          active.throwIfAborted();
        }
        return received;
      }, active);
      if (response.redirected || (response.url && response.url !== url.href))
        throw new Error("Unexpected automatic runtime download redirect");
      if (redirects.has(response.status)) {
        cancel(response.body);
        const location = response.headers.get("location");
        if (!location || ++followed > 5)
          throw new Error("Missing or excessive runtime download redirects");
        url = httpsUrl(new URL(location, url));
        response = undefined;
        continue;
      }
      // Preserve the existing exact-version PHP archive recovery, once only.
      if (
        [404, 410].includes(response.status) &&
        historicalPhpUrl &&
        !recoveredPhp
      ) {
        cancel(response.body);
        url = httpsUrl(historicalPhpUrl);
        recoveredPhp = true;
        response = undefined;
        continue;
      }
      break;
    }
    if (response.status !== 200)
      throw new Error(`Runtime download returned HTTP ${response.status}`);
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding.toLowerCase() !== "identity")
      throw new Error("Unexpected runtime download content encoding");
    const limit = expectedBytes || runtimeArchiveLimit;
    const length = response.headers.get("content-length");
    const declared = length === null ? undefined : Number(length);
    if (
      length !== null &&
      (!/^\d+$/.test(length) ||
        !Number.isSafeInteger(declared) ||
        declared <= 0 ||
        declared > limit ||
        (expectedBytes && declared !== expectedBytes))
    )
      throw new Error(
        "Runtime download content length mismatch or limit exceeded",
      );
    if (!response.body) throw new Error("Missing runtime download body");
    reader = response.body.getReader();
    let bytes = 0;
    while (true) {
      const chunk = await abortable(() => reader.read(), active);
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array))
        throw new Error("Invalid runtime download chunk");
      bytes += chunk.value.byteLength;
      if (bytes > limit || (declared !== undefined && bytes > declared))
        throw new Error("Runtime download exceeds expected size");
      if (chunk.value.byteLength) yield chunk.value;
    }
    if (
      !bytes ||
      (expectedBytes && bytes !== expectedBytes) ||
      (declared !== undefined && bytes !== declared)
    )
      throw new Error("Runtime download size mismatch or truncated body");
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    } else cancel(response?.body);
  }
}
