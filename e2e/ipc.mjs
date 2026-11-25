import { browser } from "@wdio/globals";
import { randomUUID } from "node:crypto";

export const invoke = (command, args = {}) =>
  browser.tauri.execute(
    async (tauri, command, args) => tauri.core.invoke(command, args),
    command,
    args,
  );

// The embedded driver's direct-eval endpoint has its own 30s deadline. Keep
// long native IPC operations alive in the WebView and poll with short calls.
export const invokeLong = async (command, args) => {
  const key = randomUUID();
  await browser.tauri.execute(
    (tauri, key, command, args) => {
      const tasks = (window.__stackcabinQaTasks ??= {});
      const task = (tasks[key] = { done: false });
      Promise.resolve()
        .then(() => tauri.core.invoke(command, args))
        .then(
          (value) => Object.assign(task, { done: true, value }),
          (error) => Object.assign(task, { done: true, error: String(error) }),
        );
      return true;
    },
    key,
    command,
    args,
  );
  try {
    await browser.waitUntil(
      () => browser.execute((key) => window.__stackcabinQaTasks[key].done, key),
      {
        timeout: 180000,
        interval: 500,
        timeoutMsg: `${command} did not finish`,
      },
    );
    const result = await browser.execute(
      (key) => window.__stackcabinQaTasks[key],
      key,
    );
    if (result.error) throw new Error(`${command}: ${result.error}`);
    return result.value;
  } finally {
    await browser.execute((key) => {
      delete window.__stackcabinQaTasks[key];
    }, key);
  }
};
