import { browser, $ } from "@wdio/globals";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";

const invoke = (command, args = {}) =>
  browser.tauri.execute(
    async (tauri, command, args) => tauri.core.invoke(command, args),
    command,
    args,
  );
describe("Unix QA desktop with the matching offline stack", () => {
  it("labels QA mode and installs every selected runtime through real desktop IPC", async () => {
    await browser.setTimeout({ script: 300000 });
    const state = await invoke("snapshot");
    assert.equal(state.qaMode, true);
    await $('[data-testid="qa-banner"]').waitForDisplayed();
    for (const component of ["php", "node", "mariadb", "postgres", "caddy"])
      assert.ok(state.runtimes.some((r) => r.artifact.component === component));
    for (const runtime of state.runtimes) {
      await invoke("runtime_install", {
        id: runtime.artifact.id,
        operationId: randomUUID(),
        offlineFolder: process.env.STACKCABIN_E2E_OFFLINE,
      });
    }
    await $("nav button:nth-child(3)").click();
    await browser.waitUntil(async () =>
      (await invoke("snapshot")).runtimes.every((r) => r.installed),
    );
    await browser.waitUntil(async () =>
      (await $(".runtime-card").getText()).includes("Installed"),
    );
  });
  it("starts PHP and Node from UI buttons, reads actual HTTP, backs up databases and stops from the UI", async () => {
    const created = [];
    try {
      for (const [preset, branch, engine] of [
        ["php", "8.4.", "mariadb"],
        ["node", "22.", "postgres"],
      ]) {
        const state = await invoke("snapshot");
        const runtime = state.runtimes.find(
          (r) =>
            r.artifact.component === preset &&
            r.artifact.version.startsWith(branch),
        );
        let project = await invoke("project_create", {
          parent: process.env.STACKCABIN_E2E_PROJECTS,
          name: `qa-${preset}`,
          preset,
          trusted: true,
        });
        created.push(project.id);
        project.spec.runtimes[0].version = runtime.artifact.version;
        project = await invoke("project_save", {
          id: project.id,
          spec: project.spec,
          trusted: true,
        });
        if (preset === "node") {
          const server = path.join(project.path, "server.mjs");
          await writeFile(
            server,
            (await readFile(server, "utf8")).replace(
              "res.setHeader('Content-Type'",
              "res.setHeader('X-StackCabin-Runtime',process.version);res.setHeader('Content-Type'",
            ),
          );
        }
        await invoke("database_attach", { id: project.id, engine });
        await $("nav button:nth-child(2)").click();
        const start = $(`button[aria-label="Start qa-${preset}"]`);
        await start.waitForDisplayed();
        await start.waitForClickable();
        await start.click();
        const stop = $(`button[aria-label="Stop qa-${preset}"]`);
        await stop.waitForDisplayed({ timeout: 90000 });
        const status = (await invoke("snapshot")).statuses.find(
          (s) => s.projectId === project.id,
        );
        assert.ok(status.processes.every((p) => p.state === "running"));
        const response = await fetch(status.fallbackUrl, {
          signal: AbortSignal.timeout(15000),
        });
        const body = await response.text();
        assert.ok(body.includes("ready to build"));
        if (preset === "php")
          assert.ok(body.includes(`PHP ${runtime.artifact.version}`));
        else
          assert.equal(
            response.headers.get("X-StackCabin-Runtime"),
            "v" + runtime.artifact.version,
          );
        await invoke("database_query", {
          id: project.id,
          sql: "CREATE TABLE qa_message (message VARCHAR(80)); INSERT INTO qa_message VALUES ('desktop QA');",
        });
        const backup = await invoke("backup_create", {
          id: project.id,
          operationId: randomUUID(),
        });
        const restored = await invoke("backup_restore", {
          archive: backup.path,
          destination: path.join(
            process.env.STACKCABIN_E2E_PROJECTS,
            "restored-" + preset,
          ),
          trusted: true,
        });
        const result = await invoke("database_query", {
          id: restored.id,
          sql: "SELECT message FROM qa_message;",
        });
        assert.ok(result.includes("desktop QA"));
      }
      await browser.saveScreenshot(
        path.resolve("artifacts/qa-desktop-running.png"),
      );
      for (const preset of ["php", "node"]) {
        await $(`button[aria-label="Stop qa-${preset}"]`).waitForClickable();
        await $(`button[aria-label="Stop qa-${preset}"]`).click();
        await $(`button[aria-label="Start qa-${preset}"]`).waitForDisplayed();
      }
    } finally {
      for (const id of created) await invoke("project_stop", { id });
      for (const id of ["mariadb", "postgres"])
        await invoke("service_stop", { id });
    }
  });
});
