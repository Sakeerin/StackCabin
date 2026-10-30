import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AppEvent,
  BackupInfo,
  DatabaseEngine,
  Diagnostic,
  Preset,
  Project,
  ProjectPlan,
  ProjectSpec,
  ProjectStatus,
  Settings,
  Snapshot,
} from "./types";

export const desktop = isTauri();
export async function call<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!desktop)
    throw new Error(
      "Open the desktop app with npm run desktop to use native features.",
    );
  return invoke<T>(command, args);
}
export const api = {
  snapshot: () => call<Snapshot>("snapshot"),
  detect: (path: string) => call<ProjectSpec>("project_detect", { path }),
  plan: (
    preset: Preset,
    spec: ProjectSpec | null = null,
    path: string | null = null,
  ) => call<ProjectPlan>("project_plan", { preset, spec, path }),
  create: (parent: string, name: string, preset: Preset, trusted: boolean) =>
    call<Project>("project_create", { parent, name, preset, trusted }),
  import: (path: string, spec: ProjectSpec, trusted: boolean) =>
    call<Project>("project_import", { path, spec, trusted }),
  saveProject: (id: string, spec: ProjectSpec, trusted: boolean) =>
    call<Project>("project_save", { id, spec, trusted }),
  start: (id: string) => call<ProjectStatus>("project_start", { id }),
  stop: (id: string) => call<void>("project_stop", { id }),
  forget: (id: string) => call<void>("project_forget", { id }),
  prepare: (id: string, operationId: string) =>
    call<void>("project_prepare", { id, operationId }),
  open: (id: string, target: string) =>
    call<void>("project_open", { id, target }),
  install: (
    id: string,
    operationId: string,
    offlineFolder: string | null = null,
  ) => call<void>("runtime_install", { id, operationId, offlineFolder }),
  remove: (id: string) => call<void>("runtime_remove", { id }),
  cancel: (id: string) => call<void>("operation_cancel", { id }),
  attachDatabase: (id: string, engine: DatabaseEngine) =>
    call<Project>("database_attach", { id, engine }),
  queryDatabase: (id: string, sql: string) =>
    call<string>("database_query", { id, sql }),
  startService: (engine: DatabaseEngine) =>
    call<number>("service_start", { engine }),
  stopService: (id: string) => call<void>("service_stop", { id }),
  backup: (id: string, operationId: string) =>
    call<BackupInfo>("backup_create", { id, operationId }),
  restore: (archive: string, destination: string, trusted: boolean) =>
    call<Project>("backup_restore", { archive, destination, trusted }),
  exportBackup: (id: string, destination: string) =>
    call<void>("backup_export", { id, destination }),
  saveSettings: (settings: Settings) =>
    call<void>("settings_save", { settings }),
  doctor: () => call<Diagnostic[]>("doctor"),
  logs: (subject: string | null) => call<AppEvent[]>("logs", { subject }),
  dataOpen: () => call<void>("data_open"),
};
export async function subscribe(handler: (event: AppEvent) => void) {
  if (!desktop) return () => {};
  return listen<AppEvent>("stackcabin:event", (event) =>
    handler(event.payload),
  );
}
export async function pickDirectory(): Promise<string | null> {
  if (!desktop)
    throw new Error("Folder selection is available in the desktop app.");
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ directory: true, multiple: false });
  return typeof path === "string" ? path : null;
}
export async function pickArchive(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({
    multiple: false,
    filters: [{ name: "StackCabin backup", extensions: ["zip"] }],
  });
  return typeof path === "string" ? path : null;
}
export async function saveArchive(defaultPath: string): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({
    defaultPath,
    filters: [{ name: "ZIP archive", extensions: ["zip"] }],
  });
}
export const emptySnapshot: Snapshot = {
  qaMode: false,
  projects: [],
  statuses: [],
  runtimes: [],
  services: [],
  backups: [],
  settings: {
    language: "en",
    theme: "light",
    closeToTray: true,
    proxyPort: 8080,
  },
  platform: "desktop",
  arch: "native",
  dataDirectory: "",
  catalogError: null,
};
