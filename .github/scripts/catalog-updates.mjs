// Publisher-refresh helpers. No signing key, shipping writes or production approval.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const caLatestUrl = "https://curl.se/ca/cacert.pem";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function indexed(records, label) {
  if (!Array.isArray(records))
    throw new Error(`Invalid ${label} artifact list`);
  const result = new Map();
  for (const record of records) {
    if (
      !record ||
      typeof record.id !== "string" ||
      !/^[a-zA-Z0-9._-]+$/.test(record.id)
    )
      throw new Error(`Invalid ${label} artifact identity`);
    if (
      typeof record.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.sha256) ||
      typeof record.url !== "string" ||
      !record.url.startsWith("https://")
    )
      throw new Error(`Invalid ${label} artifact integrity metadata`);
    if (result.has(record.id))
      throw new Error(`Duplicate ${label} artifact: ${record.id}`);
    result.set(record.id, record);
  }
  return result;
}

export function mergeCatalogUpdates(historical, resolved) {
  const historicalById = indexed(historical, "historical");
  const retained = indexed(resolved, "resolved");
  for (const [id, next] of retained) {
    const previous = historicalById.get(id);
    if (previous && !isDeepStrictEqual(previous, next))
      throw new Error(`Refusing to change immutable runtime metadata: ${id}`);
    if (previous) retained.set(id, previous);
  }
  // The native app chooses defaults in catalog order. Keep freshly resolved
  // records first, then retain every older identity with its original metadata.
  for (const [id, previous] of historicalById)
    if (!retained.has(id)) retained.set(id, previous);
  return [...retained.values()];
}

export function caDatedUrl(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 1024 * 1024)
    throw new Error("Expected a bounded CA PEM bundle");
  const pem = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const headers = pem
    .split(/\r?\n/)
    .filter((line) =>
      line.startsWith("## Certificate data from Mozilla as of:"),
    );
  const match =
    headers.length === 1 &&
    /^## Certificate data from Mozilla as of: (Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}(0?[1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d) ([1-9]\d{3}) GMT$/.exec(
      headers[0],
    );
  if (
    !match ||
    !/^-----BEGIN CERTIFICATE-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END CERTIFICATE-----\r?$/m.test(
      pem,
    )
  )
    throw new Error("Missing or invalid CA conversion timestamp/PEM content");
  const [, weekday, monthName, dayText, hour, minute, second, year] = match;
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ].indexOf(monthName);
  const date = new Date(
    Date.UTC(
      Number(year),
      month,
      Number(dayText),
      Number(hour),
      Number(minute),
      Number(second),
    ),
  );
  if (
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== Number(dayText) ||
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()] !==
      weekday
  )
    throw new Error("Invalid CA conversion calendar date");
  return `https://curl.se/ca/cacert-${date.toISOString().slice(0, 10)}.pem`;
}

export async function resolveCaArtifacts({
  fetchLatest,
  fetchDated,
  historical = [],
}) {
  const previous = indexed(historical, "historical");
  // Discovery deliberately bypasses the URL cache: latest changes in place.
  const discovery = await fetchLatest(caLatestUrl);
  const url = caDatedUrl(discovery);
  const latest = Buffer.from(discovery);
  const dated = await fetchDated(url);
  if (!Buffer.isBuffer(dated) || !latest.equals(dated))
    throw new Error(
      "Official dated CA bundle differs from the discovered bytes",
    );
  const sha256 = hash(dated),
    version = sha256.slice(0, 12);
  return [
    ["windows", "x64"],
    ["macos", "x64"],
    ["macos", "arm64"],
    ["linux", "x64"],
  ].map(([platform, arch]) => {
    const record = {
      id: `cacert-${version}-${platform}-${arch}`,
      component: "cacert",
      version,
      platform,
      arch,
      url,
      sha256,
      archive: "file",
      stripComponents: 0,
      executables: { cacert: "cacert.pem" },
      license: "MPL-2.0",
      sourceUrl: "https://curl.se/docs/caextract.html",
      size: dated.length,
    };
    const old = previous.get(record.id);
    // Keep a signed legacy latest URL only when every other field already agrees.
    // This is preservation, not permission to rewrite its URL under the same ID.
    return old?.url === caLatestUrl &&
      isDeepStrictEqual({ ...old, url }, record)
      ? old
      : record;
  });
}
