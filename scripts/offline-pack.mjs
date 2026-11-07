import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { root } from "./catalog-lib.mjs";
import { buildOfflinePack } from "../.github/scripts/offline-runtime-pack.mjs";

export async function main(arguments_) {
  const args = {};
  for (const argument of arguments_) {
    const match = /^--(platform|arch|cache|output)=(.+)$/.exec(argument);
    const name =
      match?.[1] ||
      (argument === "--dev"
        ? "dev"
        : argument === "--offline"
          ? "offline"
          : null);
    if (!name || Object.hasOwn(args, name))
      throw new Error("Unknown or duplicate offline pack argument");
    args[name] = match ? match[2] : true;
  }
  if (!args.platform)
    throw new Error(
      "Pass --platform=windows|macos|linux [--arch=x64|arm64] [--output=new-folder] [--offline]",
    );
  const directory = path.join(root, "artifacts");
  await mkdir(directory, { recursive: true });
  const controller = new AbortController(),
    cancel = () =>
      controller.abort(new Error("Offline pack assembly cancelled"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await buildOfflinePack({
      catalogDirectory: path.join(root, "runtime-catalog"),
      platform: args.platform,
      arch: args.arch || "x64",
      development: !!args.dev,
      offline: !!args.offline,
      output: args.output
        ? path.resolve(args.output)
        : path.join(
            directory,
            `offline-${args.platform}-${args.arch || "x64"}`,
          ),
      cache: args.cache
        ? path.resolve(args.cache)
        : path.join(root, ".local/publisher-cache"),
      signal: controller.signal,
      onProgress: (event) => {
        if (event.artifactId) console.log(`Preparing ${event.artifactId}`);
      },
    });
    console.log(result.output);
    return result;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
