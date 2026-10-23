import { browser, $, $$ } from "@wdio/globals";
import assert from "node:assert/strict";
import path from "node:path";
async function invoke(command, args = {}) {
  return browser.tauri.execute(
    async (tauri, command, args) => tauri.core.invoke(command, args),
    command,
    args,
  );
}
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
    assert.ok(state.runtimes.length > 0);
    await browser.waitUntil(
      async () => !(await $("body").getText()).includes("Browser preview"),
    );
  });
  it("shows all nine templates and defaults project trust to off", async () => {
    await $("button=New project").click();
    await $("dialog").waitForDisplayed();
    assert.equal((await $$(".preset-choice")).length, 9);
    assert.equal(await $("dialog input[type=checkbox]").isSelected(), false);
    await $("dialog").$("button=Cancel").click();
    await $("dialog").waitForDisplayed({ reverse: true });
  });
  it("persists a real project through IPC and presents its actual stopped state", async () => {
    const created = await invoke("project_create", {
      parent: process.env.STACKCABIN_E2E_PROJECTS,
      name: "desktop-integration",
      preset: "node",
      trusted: false,
    });
    assert.equal(created.trusted, false);
    await $("nav button:nth-child(2)").click();
    await $(".project-title").waitForDisplayed();
    assert.equal(await $(".project-title").getText(), "desktop-integration");
    assert.equal(await $(".project-card .status-badge").getText(), "Stopped");
    const state = await invoke("snapshot");
    assert.ok(state.projects.some((p) => p.id === created.id));
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
});
