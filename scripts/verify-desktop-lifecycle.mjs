import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { root } from "./catalog-lib.mjs";

const binary = path.resolve(
  process.env.STACKCABIN_E2E_BINARY ||
    path.join(
      root,
      "target/debug",
      `stackcabin${process.platform === "win32" ? ".exe" : ""}`,
    ),
);
const local = path.join(root, ".local");
await mkdir(local, { recursive: true });
const workspace = await mkdtemp(path.join(local, "desktop lifecycle ทดสอบ "));

// Use direct loopback HTTP, independent of machine-wide proxy configuration.
function request(port, route, payload, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? null : JSON.stringify(payload);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        method: body === null ? "GET" : "POST",
        headers:
          body === null
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
              },
      },
      (res) => {
        let bytes = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          bytes += chunk;
        });
        res.on("error", reject);
        res.on("end", () =>
          res.statusCode === 200
            ? resolve(bytes)
            : reject(new Error(`HTTP ${res.statusCode}: ${bytes}`)),
        );
      },
    );
    req.setTimeout(timeout, () =>
      req.destroy(new Error(`Loopback request timed out: ${route}`)),
    );
    req.on("error", (error) =>
      reject(new Error(`Loopback ${port}${route} failed`, { cause: error })),
    );
    req.end(body);
  });
}

async function until(probe, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch (error) {
      last = error;
    }
    await pause(50);
  }
  throw new Error(message, { cause: last });
}

async function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

const foreign = http.createServer((_req, res) =>
  res.end("unrelated lifecycle server"),
);
foreign.listen(0, "127.0.0.1");
await once(foreign, "listening");
const foreignPort = foreign.address().port;
const cases = [];

async function verify(mode) {
  const data = path.join(workspace, mode, "app-data");
  await mkdir(data, { recursive: true });
  const driver = await freePort();
  const app = spawn(binary, [], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      STACKCABIN_DATA_DIR: data,
      STACKCABIN_LIFECYCLE_TEST: "1",
      TAURI_WEBDRIVER_PORT: String(driver),
      WDIO_EMBEDDED_SERVER: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [app.stdout, app.stderr])
    stream.on("data", (chunk) => {
      output = (output + chunk).slice(-12000);
    });
  const exited = new Promise((resolve, reject) => {
    app.once("error", reject);
    app.once("exit", (code, signal) => resolve({ code, signal }));
  });
  // Keep spawn failures observed even while waiting for the HTTP server.
  exited.catch(() => {});
  const alive = () => app.exitCode === null && app.signalCode === null;
  const evidence = async () => {
    try {
      return JSON.parse(
        await readFile(path.join(data, "lifecycle-evidence.json"), "utf8"),
      );
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  const invoke = async (command, args = {}) => {
    const script = `var done=arguments[arguments.length-1]; Promise.resolve().then(function(){return window.__TAURI__.core.invoke(${JSON.stringify(command)},${JSON.stringify(args)});}).then(function(value){done({ok:true,value:value});},function(error){done({ok:false,error:String(error)});});`;
    const result = JSON.parse(
      await request(
        driver,
        "/wdio/eval",
        { script, window_label: "main", timeout_ms: 10000 },
        12000,
      ),
    );
    if (result.error) throw new Error(result.error);
    return result.value;
  };
  const action = (action) => invoke("lifecycle_test", { action });
  let port;
  let runtimeId;
  try {
    await until(
      async () => {
        if (!alive())
          throw new Error(`Application exited during startup: ${output}`);
        const state = await action("inspect");
        assert.equal(
          state.pid,
          app.pid,
          "WebDriver belongs to a different process",
        );
        return state.visible && state.running;
      },
      `Native lifecycle application did not become ready: ${mode}`,
      60000,
    );
    ({ port } = await action("start_worker"));
    assert.equal(await request(port, "/"), "StackCabin lifecycle fixture");
    assert.equal(await request(foreignPort, "/"), "unrelated lifecycle server");
    if (mode === "busy") {
      runtimeId = (await invoke("snapshot")).runtimes[0].artifact.id;
      await action("start_work");
      await until(
        async () => (await evidence()).includes("work_started"),
        "Accepted work did not start",
      );
    }

    if (mode === "crash") {
      app.kill("SIGKILL");
    } else {
      await invoke("settings_save", {
        settings: {
          language: "en",
          theme: "light",
          closeToTray: mode === "tray",
          proxyPort: 8080,
        },
      });
      await action("close");
      if (mode === "tray") {
        await until(
          async () => !(await action("inspect")).visible,
          "Close did not hide the native window",
        );
        assert.ok(alive(), "Close-to-tray exited the application");
        assert.deepEqual(await evidence(), [], "Close-to-tray began shutdown");
        assert.equal(await request(port, "/"), "StackCabin lifecycle fixture");
        await action("show");
        await until(
          async () => (await action("inspect")).visible,
          "Tray Open handler did not restore the window",
        );
        await action("quit");
      }
      await until(
        async () => (await evidence()).includes("shutdown_started"),
        "Quit did not start shutdown",
      );
      // The test barrier keeps shutdown pending until these real native events
      // are processed. Repeated Quit must not exit or destroy the final WebView.
      const pending = await action("inspect");
      assert.equal(pending.running, false);
      assert.equal(pending.visible, true);
      await action("quit");
      await until(
        async () => (await evidence()).includes("exit_waiting"),
        "Repeated Quit bypassed the shutdown guard",
      );
      assert.ok(alive(), "Repeated Quit exited before shutdown completed");
      assert.equal(await request(port, "/"), "StackCabin lifecycle fixture");
      if (mode === "busy") {
        for (const [command, args] of [
          [
            "project_create",
            {
              parent: path.join(workspace, mode),
              name: "late-project",
              preset: "static",
              trusted: false,
            },
          ],
          [
            "project_prepare",
            { id: "late-project", operationId: "late-prepare" },
          ],
          [
            "runtime_install",
            { id: runtimeId, operationId: "late-install", offlineFolder: data },
          ],
          [
            "settings_save",
            {
              settings: {
                language: "en",
                theme: "light",
                closeToTray: false,
                proxyPort: 8080,
              },
            },
          ],
        ]) {
          await assert.rejects(
            invoke(command, args),
            /shutting down/i,
            `${command} admitted new work during shutdown`,
          );
        }
        await assert.rejects(
          readFile(
            path.join(workspace, mode, "late-project", "stackcabin.json"),
          ),
          { code: "ENOENT" },
        );
      }
      await writeFile(path.join(data, "lifecycle-release"), "release\n");
      if (mode === "busy") {
        await until(
          async () => (await evidence()).includes("shutdown_draining"),
          "Shutdown did not begin draining work",
        );
        assert.ok(alive(), "Application did not wait for accepted work");
        assert.ok(!(await evidence()).includes("shutdown_complete"));
        assert.equal(await request(port, "/"), "StackCabin lifecycle fixture");
        await writeFile(path.join(data, "work-release"), "release\n");
      }
    }

    let exit;
    await until(async () => {
      if (!alive()) {
        exit = await exited;
        return true;
      }
    }, "Native application did not exit");
    await until(
      async () => !(await listening(port)),
      "Native exit left its owned service listening",
      8000,
    );
    assert.equal(await request(foreignPort, "/"), "unrelated lifecycle server");
    const stages = await evidence();
    if (mode === "crash")
      assert.deepEqual(stages, [], "Crash unexpectedly ran graceful shutdown");
    else {
      assert.deepEqual(exit, { code: 0, signal: null });
      assert.equal(
        stages.filter((stage) => stage === "shutdown_started").length,
        1,
      );
      assert.ok(stages.includes("exit_waiting"));
      assert.ok(
        stages.indexOf("shutdown_complete") >
          stages.indexOf("shutdown_started"),
      );
      assert.ok(
        stages.indexOf("exit_allowed") > stages.indexOf("shutdown_complete"),
      );
      if (mode === "busy") {
        assert.ok(
          stages.indexOf("work_finished") > stages.indexOf("shutdown_draining"),
        );
        assert.ok(
          stages.indexOf("shutdown_complete") > stages.indexOf("work_finished"),
        );
      }
    }
    const result = {
      mode,
      appPid: app.pid,
      ownedPort: port,
      unrelatedPort: foreignPort,
      exit,
      stages,
    };
    cases.push(result);
    console.log(
      `PASS ${mode}: native window lifecycle, owned service stopped, unrelated server healthy`,
    );
  } catch (error) {
    throw new Error(`Native lifecycle ${mode} failed\n${output}`, {
      cause: error,
    });
  } finally {
    if (alive()) app.kill("SIGKILL");
    await exited.catch(() => {});
  }
}

try {
  for (const mode of ["tray", "close", "crash", "busy"]) await verify(mode);
  const artifacts = path.join(root, "artifacts");
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    path.join(
      artifacts,
      `desktop-lifecycle-${process.platform}-${process.arch}.json`,
    ),
    JSON.stringify(
      { platform: process.platform, arch: process.arch, binary, cases },
      null,
      2,
    ) + "\n",
  );
} finally {
  foreign.closeAllConnections();
  await new Promise((resolve) => foreign.close(resolve));
  // Delete only this run's newly created physical workspace, never user data.
  const actual = await realpath(workspace);
  const fromRoot = path.relative(await realpath(root), actual);
  assert.ok(
    fromRoot && !fromRoot.startsWith("..") && !path.isAbsolute(fromRoot),
  );
  const relative = path.relative(await realpath(local), actual);
  assert.ok(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
  );
  assert.ok(path.basename(actual).startsWith("desktop lifecycle ทดสอบ "));
  await rm(actual, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
