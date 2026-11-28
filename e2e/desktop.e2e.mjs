import { browser, $, $$ } from "@wdio/globals";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { invoke, invokeLong } from "./ipc.mjs";
describe("StackCabin native desktop", () => {
  before(async () => {
    const handles = await browser.getWindowHandles();
    assert.equal(handles.length, 1);
    await browser.switchToWindow(handles[0]);
  });
  it("connects the UI to the real native store and signed catalog", async () => {
    await $("h1").waitForDisplayed();
    const state = await invoke("snapshot");
    assert.equal(state.catalogError, null);
    assert.equal(state.qaMode, process.env.STACKCABIN_E2E_QA === "1");
    assert.ok(state.runtimes.length > 0);
    await browser.waitUntil(
      async () => !(await $("body").getText()).includes("Browser preview"),
    );
  });
  it("reviews a different Node.js version in the new project wizard before granting trust", async () => {
    await $("button=New project").click();
    await $("dialog").waitForDisplayed();
    assert.equal((await $$(".preset-choice")).length, 9);
    assert.equal(await $("dialog input[type=checkbox]").isSelected(), false);
    await browser.waitUntil(async () =>
      (await $("dialog .setup-review").getText()).includes("npm install"),
    );
    const { runtimes } = await invoke("snapshot");
    const node22 = runtimes.find(
      ({ artifact }) =>
        artifact.component === "node" && artifact.version.startsWith("22."),
    ).artifact.version;
    const trust = await $("dialog input[type=checkbox]");
    await trust.scrollIntoView();
    await trust.click();
    assert.equal(await trust.isSelected(), true);
    await browser.execute((version) => {
      const select = document.querySelector("dialog select");
      select.value = version;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }, node22);
    await browser.waitUntil(async () =>
      (await $("dialog .setup-review").getText()).includes("node " + node22),
    );
    await $("dialog .setup-review").scrollIntoView();
    await browser.saveScreenshot(
      path.resolve("artifacts/project-wizard-review.png"),
    );
    assert.equal(await $("dialog input[type=checkbox]").isSelected(), false);
    await $("dialog").$("button=Cancel").scrollIntoView();
    await $("dialog").$("button=Cancel").click();
    await $("dialog").waitForDisplayed({ reverse: true });
  });
  it("persists a real project through IPC and presents its actual stopped state", async () => {
    const before = await invoke("snapshot");
    const plan = await invoke("project_plan", {
      preset: "laravel",
      spec: null,
      path: null,
    });
    assert.equal(plan.commands[0].tool, "composer");
    assert.equal(plan.processes.length, 2);
    assert.equal(
      (await invoke("snapshot")).projects.length,
      before.projects.length,
    );
    const created = await invoke("project_create", {
      parent: process.env.STACKCABIN_E2E_PROJECTS,
      name: "desktop-integration",
      preset: "node",
      trusted: false,
      runtimes: [{ component: "node", version: "22" }],
    });
    assert.equal(created.trusted, false);
    const node22 = before.runtimes.find(
      ({ artifact }) =>
        artifact.component === "node" && artifact.version.startsWith("22."),
    ).artifact.version;
    assert.deepEqual(created.spec.runtimes, [
      { component: "node", version: node22 },
    ]);
    await $("nav button:nth-child(2)").click();
    await $(".project-title").waitForDisplayed();
    assert.equal(await $(".project-title").getText(), "desktop-integration");
    assert.equal(await $(".project-card .status-badge").getText(), "Stopped");
    const state = await invoke("snapshot");
    assert.ok(state.projects.some((p) => p.id === created.id));
    await $(".project-title").click();
    await $("button=Install dependencies").click();
    await $("dialog").waitForDisplayed();
    await browser.waitUntil(async () =>
      (await $("dialog .setup-review").getText()).includes("npm install"),
    );
    assert.equal(await $("dialog input[type=checkbox]").isSelected(), false);
    assert.equal(
      await $("dialog .modal-footer button.primary").isEnabled(),
      false,
    );
    assert.equal(
      (await invoke("snapshot")).projects.find((p) => p.id === created.id)
        .trusted,
      false,
    );
    await browser.saveScreenshot(
      path.resolve("artifacts/project-setup-review.png"),
    );
    await $("dialog").$("button=Cancel").click();
    await $("dialog").waitForDisplayed({ reverse: true });
    const afterReview = await invoke("snapshot");
    assert.deepEqual(
      afterReview.projects.find((p) => p.id === created.id),
      created,
    );
    assert.deepEqual(
      afterReview.runtimes.map((r) => r.installed),
      before.runtimes.map((r) => r.installed),
    );
  });
  it("switches theme and language and persists both in the native database", async () => {
    await $(".sidebar-bottom button").click();
    await $("button=Dark").click();
    await browser.waitUntil(
      async () => (await invoke("snapshot")).settings.theme === "dark",
    );
    // The embedded driver does not implement native <option> selection.
    // Dispatch the DOM change event; persistence still goes through the real native IPC.
    await browser.execute(() => {
      const select = document.querySelector("select");
      select.value = "th";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await browser.waitUntil(
      async () => (await invoke("snapshot")).settings.language === "th",
    );
    assert.equal(await $("h1").getText(), "ปรับพื้นที่ให้เป็นของคุณ");
    await invoke("settings_save", {
      settings: {
        language: "en",
        theme: "light",
        closeToTray: true,
        proxyPort: 8080,
      },
    });
    await browser.waitUntil(
      async () => (await $("h1").getText()) === "Make the cabin yours.",
    );
    await $('button[aria-label="StackCabin home"]').click();
    await browser.saveScreenshot(
      path.resolve("artifacts/stackcabin-desktop.png"),
    );
  });

  it("recovers and stops a partially failed project from the Projects list", async function () {
    this.timeout(300000);
    const project = await invoke("project_create", {
      parent: process.env.STACKCABIN_E2E_PROJECTS,
      name: "two-process-project",
      preset: "node",
      trusted: true,
    });
    const status = async () =>
      (await invoke("snapshot")).statuses.find(
        (entry) => entry.projectId === project.id,
      );
    const button = (action) =>
      $(`button[aria-label="${action} two-process-project"]`);
    const marker = path.join(project.path, "exit-sidecar");
    async function failSidecar() {
      await writeFile(marker, "");
      await $(".project-card .status-badge.failed").waitForDisplayed();
      const run = await status();
      assert.equal(
        run.processes.find((p) => p.name === "sidecar").state,
        "failed",
      );
      assert.equal(
        run.processes.find((p) => p.name === "web").state,
        "running",
      );
      const response = await fetch(run.fallbackUrl, {
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /ready to build/);
      await unlink(marker);
      return run;
    }
    try {
      const { runtimes } = await invoke("snapshot");
      const nodeVersion = project.spec.runtimes.find(
        (r) => r.component === "node",
      ).version;
      const node = runtimes.find(
        ({ artifact }) =>
          artifact.component === "node" && artifact.version === nodeVersion,
      );
      const caddy = runtimes.find(
        ({ artifact }) => artifact.component === "caddy",
      );
      assert.ok(
        node && caddy,
        "The pinned Node.js and Caddy runtimes are required",
      );
      for (const runtime of [node, caddy]) {
        if (!runtime.installed)
          await invokeLong("runtime_install", {
            id: runtime.artifact.id,
            operationId: randomUUID(),
            offlineFolder: process.env.STACKCABIN_E2E_OFFLINE ?? null,
          });
      }
      await writeFile(
        path.join(project.path, "sidecar.mjs"),
        [
          'import "./server.mjs";',
          'import { existsSync } from "node:fs";',
          'setInterval(() => { if (existsSync("exit-sidecar")) process.exit(7); }, 100);',
        ].join("\n"),
      );
      const web = {
        ...project.spec.processes[0],
        tool: "node",
        args: ["server.mjs"],
      };
      const sidecar = {
        ...web,
        name: "sidecar",
        args: ["sidecar.mjs"],
        port: 5173,
      };
      await invoke("project_save", {
        id: project.id,
        spec: { ...project.spec, processes: [web, sidecar] },
        trusted: true,
      });
      await $("nav button:nth-child(2)").click();
      await button("Start").waitForClickable();
      await button("Start").click();
      await button("Stop").waitForClickable({ timeout: 90000 });
      const failed = await failSidecar();
      await button("Restart").click();
      await browser.waitUntil(
        async () => {
          const run = await status();
          return (
            run?.processes.length === 2 &&
            run.processes.every((p) => p.state === "running")
          );
        },
        { timeout: 90000 },
      );
      const recovered = await status();
      assert.notEqual(
        recovered.processes.find((p) => p.name === "web").pid,
        failed.processes.find((p) => p.name === "web").pid,
      );
      await $(".project-card .status-badge.running").waitForDisplayed();
      await failSidecar();
      await button("Stop").waitForClickable();
      await button("Stop").click();
      await button("Start").waitForClickable();
      assert.equal(await status(), undefined);
    } finally {
      await invoke("project_forget", { id: project.id });
    }
  });
});

if (process.env.STACKCABIN_E2E_QA === "1" && process.env.STACKCABIN_E2E_OFFLINE)
  await import("./qa.e2e.mjs");
