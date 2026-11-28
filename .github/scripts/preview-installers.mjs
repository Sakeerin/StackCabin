// Metadata discovery only: the downloaded ZIP and its installers still need
// checksum verification. Successful hosted builds do not certify clean machines.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { verifyInstallerRun } from "../../scripts/verify-offline-installer-source.mjs";

const execute = promisify(execFile);
export const previewTargets = Object.freeze({
  "windows-x64": "development-installers-windows-latest",
  "linux-x64": "development-installers-ubuntu-22.04",
  "macos-arm64": "development-installers-macos-15",
  "macos-x64": "development-installers-macos-15-intel",
});
const workflow = "preview-installers.yml";
const marginMs = 15 * 60 * 1000;
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;
const repositoryName = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(
    value,
  );

function targetsFor(target) {
  if (target === "all") return Object.keys(previewTargets);
  if (!Object.hasOwn(previewTargets, target))
    throw new Error(`Unknown preview target: ${target}`);
  return [target];
}

function timestamp(value) {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString().replace(".000Z", "Z") !== value
  )
    throw new Error("Invalid artifact timestamp");
  return time;
}

export function verifyAvailablePreview(
  run,
  artifacts,
  { repository, runId, target = "all", now = Date.now() },
) {
  if (!repositoryName(repository) || !Number.isFinite(now))
    throw new Error("Invalid repository or discovery time");
  const targets = targetsFor(target);
  const sourceCommit = verifyInstallerRun(run, repository, runId);
  if (
    !positiveId(run.id) ||
    run.head_branch !== "main" ||
    !positiveId(run.repository?.id) ||
    run.head_repository?.id !== run.repository.id
  )
    throw new Error("Expected a main-branch installer from this repository");
  if (!Array.isArray(artifacts)) throw new Error("Invalid artifact list");
  const selected = targets.map((platform) => {
    const name = previewTargets[platform];
    const matching = artifacts.filter((artifact) => artifact?.name === name);
    if (matching.length !== 1)
      throw new Error(`Missing or ambiguous installer artifact: ${name}`);
    const artifact = matching[0];
    if (
      artifact.expired !== false ||
      timestamp(artifact.expires_at) <= now + marginMs
    )
      throw new Error(
        `Installer artifact expired or expires within 15 minutes: ${name}`,
      );
    if (
      !positiveId(artifact.id) ||
      !positiveId(artifact.size_in_bytes) ||
      artifact.size_in_bytes > 8 * 1024 ** 3 ||
      !/^sha256:[a-f0-9]{64}$/.test(artifact.digest || "") ||
      timestamp(artifact.created_at) >= timestamp(artifact.expires_at)
    )
      throw new Error(`Invalid artifact identity, size or digest: ${name}`);
    const producer = artifact.workflow_run;
    if (
      producer?.id !== run.id ||
      producer.head_sha !== sourceCommit ||
      producer.head_branch !== run.head_branch ||
      producer.repository_id !== run.repository.id ||
      producer.head_repository_id !== run.repository.id
    )
      throw new Error(
        `Artifact producer does not match the installer run: ${name}`,
      );
    return {
      target: platform,
      artifactId: artifact.id,
      artifactName: name,
      sizeBytes: artifact.size_in_bytes,
      archiveSha256: artifact.digest.slice(7),
      expiresAt: artifact.expires_at,
      url: `https://github.com/${repository}/actions/runs/${runId}/artifacts/${artifact.id}`,
      downloadCommand: [
        "gh",
        "run",
        "download",
        runId,
        "--repo",
        repository,
        "--name",
        name,
        "--dir",
        `installers/${platform}`,
      ],
    };
  });
  return {
    schemaVersion: 1,
    scope: "github-artifact-availability",
    checkedAt: new Date(now).toISOString(),
    repository,
    runId,
    sourceCommit,
    runUrl: `https://github.com/${repository}/actions/runs/${runId}`,
    artifacts: selected,
    contentVerified: false,
  };
}

export async function findPreviewInstallers({
  request,
  repository = "Sakeerin/StackCabin",
  target = "all",
  runId,
  now = () => Date.now(),
} = {}) {
  if (!repositoryName(repository)) throw new Error("Invalid GitHub repository");
  targetsFor(target);
  if (typeof request !== "function" || typeof now !== "function")
    throw new Error("Metadata request and clock functions are required");
  if (
    runId !== undefined &&
    (typeof runId !== "string" || !/^[1-9]\d*$/.test(runId))
  )
    throw new Error("A numeric installer run ID is required");
  const base = `repos/${repository}/actions`;
  async function readMetadata(endpoint) {
    try {
      return await request(endpoint);
    } catch {
      const error = new Error(
        "Cannot read GitHub metadata. Check GitHub CLI authentication and network access, then retry.",
      );
      error.metadataRequestFailed = true;
      throw error;
    }
  }
  async function inspect(run) {
    const id = String(run?.id);
    // Reject an unrelated run before making any artifact requests.
    verifyInstallerRun(run, repository, id);
    const artifacts = [];
    for (let page = 1; page <= 10; page++) {
      const data = await readMetadata(
        `${base}/runs/${id}/artifacts?per_page=100&page=${page}`,
      );
      if (
        !Number.isSafeInteger(data?.total_count) ||
        data.total_count < 0 ||
        !Array.isArray(data.artifacts) ||
        data.artifacts.length > 100
      )
        throw new Error("Invalid GitHub artifact response");
      artifacts.push(...data.artifacts);
      if (artifacts.length === data.total_count)
        return verifyAvailablePreview(run, artifacts, {
          repository,
          runId: id,
          target,
          now: now(),
        });
      if (artifacts.length > data.total_count || data.artifacts.length < 100)
        throw new Error("Incomplete GitHub artifact response");
    }
    throw new Error("Artifact discovery exceeded 1,000 entries");
  }
  if (runId !== undefined) {
    const run = await readMetadata(`${base}/runs/${runId}`);
    verifyInstallerRun(run, repository, runId);
    return inspect(run);
  }
  const rejected = [];
  // Bound discovery to the sixty most recent successful main-branch builds.
  // Explicit selections never fall back to another run.
  for (let page = 1; page <= 3; page++) {
    const data = await readMetadata(
      `${base}/workflows/${workflow}/runs?status=success&event=workflow_dispatch&branch=main&per_page=20&page=${page}`,
    );
    if (!Array.isArray(data?.workflow_runs) || data.workflow_runs.length > 20)
      throw new Error("Invalid GitHub workflow response");
    for (const run of data.workflow_runs) {
      try {
        return await inspect(run);
      } catch (error) {
        // Network/authentication errors must not masquerade as expired builds.
        if (error?.metadataRequestFailed) throw error;
        rejected.push({ runId: String(run?.id), reason: error.message });
      }
    }
    if (data.workflow_runs.length < 20) break;
  }
  const error = new Error(
    `No available ${target} preview installer found in the latest 60 successful main-branch builds. Run the Build and verify development installers workflow again.`,
  );
  error.rejectedRuns = rejected;
  throw error;
}

export function parsePreviewArguments(args) {
  const options = {};
  for (const argument of args) {
    const match = /^--(repository|target|run-id)=(.+)$/.exec(argument);
    if (!match)
      throw new Error(`Unknown or empty preview argument: ${argument}`);
    const key = match[1] === "run-id" ? "runId" : match[1];
    if (Object.hasOwn(options, key))
      throw new Error(`Duplicate preview argument: ${match[1]}`);
    options[key] = match[2];
  }
  return options;
}

export async function githubMetadata(endpoint, run = execute, wait = delay) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await run(
        "gh",
        ["api", "--hostname", "github.com", endpoint],
        {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 4 * 1024 ** 2,
          windowsHide: true,
        },
      );
    } catch (error) {
      const stderr = String(error.stderr ?? "");
      const http = /\bHTTP (\d{3})\b/i.exec(stderr);
      const retryable = http
        ? ["500", "502", "503", "504"].includes(http[1])
        : error.killed === true ||
          /error connecting to api\.github\.com|connection reset|connection timed out|i\/o timeout|TLS handshake timeout|wsarecv/i.test(
            stderr,
          );
      if (attempt >= 2 || !retryable) throw error;
      await wait(1000 * (attempt + 1));
      continue;
    }
    return JSON.parse(response.stdout);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await findPreviewInstallers({
      ...parsePreviewArguments(process.argv.slice(2)),
      request: githubMetadata,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    if (error.rejectedRuns)
      console.error(JSON.stringify(error.rejectedRuns, null, 2));
    process.exitCode = 1;
  }
}
