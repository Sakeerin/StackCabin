import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Box,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  Code2,
  Coffee,
  Database,
  Download,
  ExternalLink,
  Files,
  Folder,
  FolderOpen,
  HardDrive,
  House,
  Layers3,
  Loader2,
  Monitor,
  Moon,
  MoreHorizontal,
  Package,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Square,
  Sun,
  Terminal,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import {
  api,
  desktop,
  emptySnapshot,
  pickArchive,
  pickDirectory,
  saveArchive,
  subscribe,
} from "./lib/api";
import type {
  AppEvent,
  DatabaseEngine,
  Diagnostic,
  Preset,
  Project,
  ProjectSpec,
  ProjectStatus,
  RuntimeInfo,
  Settings,
  Snapshot,
} from "./lib/types";
import { translator, type T } from "./lib/i18n";

type Page =
  "dashboard" | "projects" | "runtimes" | "services" | "backups" | "settings";
type Wizard = "new" | "import" | "restore" | null;
type Task = {
  id: string;
  title: string;
  progress: number | null;
  cancellable: boolean;
};
const presets: {
  id: Preset;
  name: string;
  mark: string;
  color: string;
  description: string;
}[] = [
  {
    id: "static",
    name: "Static",
    mark: "</>",
    color: "sand",
    description: "HTML, CSS & JavaScript",
  },
  {
    id: "php",
    name: "PHP",
    mark: "php",
    color: "purple",
    description: "A clean PHP workspace",
  },
  {
    id: "laravel",
    name: "Laravel",
    mark: "L",
    color: "red",
    description: "PHP, with a framework",
  },
  {
    id: "node",
    name: "Node.js",
    mark: "JS",
    color: "green",
    description: "A little JavaScript server",
  },
  {
    id: "express",
    name: "Express",
    mark: "ex",
    color: "slate",
    description: "Your next API",
  },
  {
    id: "vue",
    name: "Vue",
    mark: "V",
    color: "green",
    description: "Progressive frontend",
  },
  {
    id: "react",
    name: "React",
    mark: "⚛",
    color: "blue",
    description: "A reactive starting point",
  },
  {
    id: "nest",
    name: "NestJS",
    mark: "N",
    color: "red",
    description: "A structured backend",
  },
  {
    id: "next",
    name: "Next.js",
    mark: "N",
    color: "slate",
    description: "A full-stack React app",
  },
];
const names: Record<string, string> = {
  node: "Node.js",
  php: "PHP",
  caddy: "Caddy",
  composer: "Composer",
  mariadb: "MariaDB",
  postgres: "PostgreSQL",
  pnpm: "pnpm",
  yarn: "Yarn",
};
export function formatBytes(value: number | bigint): string {
  const bytes = Number(value);
  if (!bytes) return "—";
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${["B", "KB", "MB", "GB"][i]}`;
}
export function projectState(
  status?: ProjectStatus,
): "running" | "stopped" | "failed" | "starting" | "stopping" {
  if (!status?.processes.length) return "stopped";
  if (status.processes.some((p) => p.state === "failed")) return "failed";
  if (status.processes.some((p) => p.state === "starting")) return "starting";
  if (status.processes.some((p) => p.state === "stopping")) return "stopping";
  return status.processes.every((p) => p.state === "running")
    ? "running"
    : "stopped";
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [page, setPage] = useState<Page>("dashboard");
  const [selected, setSelected] = useState<string | null>(null);
  const [wizard, setWizard] = useState<Wizard>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [task, setTask] = useState<Task | null>(null);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const taskRef = useRef<Task | null>(null);
  const settingsQueue = useRef<Promise<void>>(Promise.resolve());
  taskRef.current = task;
  const t = translator(snapshot.settings.language);

  const refresh = useCallback(async () => {
    if (!desktop) return;
    try {
      setSnapshot(await api.snapshot());
      setConnected(true);
    } catch (e) {
      setConnected(false);
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
    if (!desktop) return;
    const timer = setInterval(() => {
      void refresh();
    }, 2500);
    let dispose: (() => void) | undefined;
    let disposed = false;
    void subscribe((event) => {
      setEvents((current) => [...current.slice(-999), event]);
      if (
        event.operationId &&
        taskRef.current?.id === event.operationId &&
        event.progress !== null
      )
        setTask((current) =>
          current ? { ...current, progress: event.progress } : null,
        );
    }).then((fn) => {
      if (disposed) fn();
      else dispose = fn;
    });
    void api
      .logs(null)
      .then(setEvents)
      .catch(() => {});
    return () => {
      disposed = true;
      clearInterval(timer);
      dispose?.();
    };
  }, [refresh]);
  useEffect(() => {
    const theme = snapshot.settings.theme;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    media.addEventListener("change", apply);
    document.documentElement.lang = snapshot.settings.language;
    return () => media.removeEventListener("change", apply);
  }, [snapshot.settings]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5500);
    return () => clearTimeout(timer);
  }, [notice]);

  async function run(
    action: () => Promise<unknown>,
    title?: string,
    cancellable = false,
  ) {
    if (busy) return;
    setError(null);
    setBusy(true);
    const id = crypto.randomUUID();
    if (title) setTask({ id, title, progress: null, cancellable });
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      setTask(null);
    }
  }
  async function operation(
    title: string,
    action: (id: string) => Promise<unknown>,
    cancellable = false,
  ) {
    const id = crypto.randomUUID();
    await run(async () => {
      setTask({ id, title, progress: null, cancellable });
      await action(id);
    });
  }
  async function setupRuntimes(project: Project) {
    const requirements = [
      ...project.spec.runtimes,
      { component: "caddy", version: "" },
    ];
    if (["php", "laravel"].includes(project.spec.preset))
      requirements.push(
        { component: "composer", version: "" },
        { component: "cacert", version: "" },
      );
    for (const process of project.spec.processes)
      if (["pnpm", "yarn"].includes(process.tool))
        requirements.push({ component: process.tool, version: "" });
    for (const required of requirements) {
      const runtime = snapshot.runtimes.find(
        (r) =>
          r.artifact.component === required.component &&
          (!required.version ||
            r.artifact.version === required.version ||
            r.artifact.version.startsWith(`${required.version}.`)),
      );
      if (!runtime)
        throw new Error(
          `No verified ${required.component} ${required.version} package is available for ${snapshot.platform}/${snapshot.arch}. Add a tested source-built package to the signed catalog.`,
        );
      if (!runtime.installed) {
        const id = crypto.randomUUID();
        setTask({
          id,
          title: `${t("install")} ${names[required.component] || required.component} ${runtime.artifact.version}`,
          progress: 0,
          cancellable: true,
        });
        await api.install(runtime.artifact.id, id);
      }
    }
  }
  async function saveSettings(settings: Settings) {
    setSnapshot((current) => ({ ...current, settings }));
    if (!desktop) {
      return;
    }
    const pending = settingsQueue.current.then(() =>
      api.saveSettings(settings),
    );
    settingsQueue.current = pending.catch((error) => {
      setError(errorText(error));
    });
    await settingsQueue.current;
  }
  function navigate(next: Page) {
    setPage(next);
    setSelected(null);
  }
  const project = snapshot.projects.find((p) => p.id === selected);
  const active = snapshot.statuses.filter(
    (s) => projectState(s) === "running",
  ).length;
  const nav = [
    { id: "dashboard", icon: House },
    { id: "projects", icon: Files },
    { id: "runtimes", icon: Layers3 },
    { id: "services", icon: Server },
    { id: "backups", icon: HardDrive },
  ] as const;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          className="brand"
          onClick={() => navigate("dashboard")}
          aria-label="StackCabin home"
        >
          <img src="/cabin.svg" alt="" />
          <span>
            stack<span className="brand-soft">cabin</span>
            <small>YOUR LOCAL WORKSPACE</small>
          </span>
        </button>
        <div className="workspace-label">
          <span className="tiny-dot" />
          Personal workspace
          <ChevronDown size={14} />
        </div>
        <div className="nav-section-label">{t("workspace")}</div>
        <nav>
          {nav.map(({ id, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${page === id ? "active" : ""}`}
              onClick={() => navigate(id)}
            >
              <Icon size={19} />
              <span>{t(id)}</span>
              {id === "projects" && snapshot.projects.length > 0 && (
                <em>{snapshot.projects.length}</em>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <div className="note-icon">
            <ShieldCheck size={19} />
          </div>
          <strong>{t("local")}</strong>
          <p>{t("localSub")}</p>
          <span className="local-tag">
            <span className="tiny-dot" />
            {desktop
              ? `${snapshot.platform} / ${snapshot.arch}`
              : "DESKTOP PREVIEW"}
          </span>
        </div>
        <div className="sidebar-bottom">
          <button
            className={`nav-item ${page === "settings" ? "active" : ""}`}
            onClick={() => navigate("settings")}
          >
            <Settings2 size={19} />
            {t("settings")}
          </button>
          <div className="version">
            <span className="version-logo">sc</span>
            <span>
              StackCabin <small>v0.1.0 · early access</small>
            </span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            {t("workspace")}
            <ChevronRight size={14} />
            <span>{project ? project.spec.name : t(page)}</span>
          </div>
          <div className="topbar-right">
            <span className={`connection ${connected ? "online" : ""}`}>
              <span className="tiny-dot" />
              {connected ? t("native") : t("preview")}
            </span>
            <span className="topbar-divider" />
            <button
              className="icon-button"
              title={t("doctor")}
              onClick={() => navigate("settings")}
            >
              <CircleHelp size={19} />
            </button>
            <span className="avatar">SC</span>
          </div>
        </header>
        <main>
          {!desktop && (
            <div className="preview-banner">
              <Monitor size={16} />
              <span>
                <strong>{t("preview")}</strong> · {t("previewSub")}{" "}
                <code>npm run desktop</code>
              </span>
            </div>
          )}
          {snapshot.catalogError && (
            <div className="inline-alert">
              <TriangleAlert size={18} />
              <span>
                {t("noCatalog")}: {snapshot.catalogError}
              </span>
            </div>
          )}
          {project ? (
            <ProjectDetail
              project={project}
              snapshot={snapshot}
              t={t}
              busy={busy}
              events={events}
              onBack={() => setSelected(null)}
              run={run}
              onStart={() => run(() => api.start(project.id), t("starting"))}
              onStop={() => run(() => api.stop(project.id), t("stopping"))}
              onSetup={() => run(() => setupRuntimes(project))}
              onPrepare={() =>
                operation(
                  t("dependencies"),
                  (id) => api.prepare(project.id, id),
                  true,
                )
              }
              onBackup={() =>
                operation(t("backup"), (id) => api.backup(project.id, id))
              }
              onForget={() => {
                if (confirm(t("forgetHelp")))
                  void run(async () => {
                    await api.forget(project.id);
                    setSelected(null);
                  });
              }}
            />
          ) : (
            <>
              {page === "dashboard" && (
                <>
                  <PageHeading
                    eyebrow="THE WORKSPACE, SIMPLIFIED"
                    title={t("welcome")}
                    description={t("welcomeSub")}
                  >
                    <button
                      className="button secondary"
                      onClick={() => setWizard("import")}
                    >
                      <FolderOpen size={16} />
                      {t("importProject")}
                    </button>
                    <button
                      className="button primary"
                      onClick={() => setWizard("new")}
                    >
                      <Plus size={17} />
                      {t("newProject")}
                    </button>
                  </PageHeading>
                  <section className="hero">
                    <div className="hero-copy">
                      <span className="eyebrow">{t("heroEyebrow")}</span>
                      <h2>{t("heroTitle")}</h2>
                      <p>{t("heroDescription")}</p>
                      <button
                        className="button hero-button"
                        onClick={() => setWizard("new")}
                      >
                        {t("newProject")}
                        <ArrowUpRight size={17} />
                      </button>
                      <div className="hero-chips">
                        <span>PHP</span>
                        <span>Node.js</span>
                        <span>Vue</span>
                        <span>React</span>
                        <span>+ more</span>
                      </div>
                    </div>
                    <CabinIllustration />
                    <span className="hero-corner">BUILT FOR YOUR FLOW</span>
                  </section>
                  <div className="stats-grid">
                    <Stat
                      icon={<Folder size={20} />}
                      value={snapshot.projects.length}
                      label={t("totalProjects")}
                      detail="PROJECTS"
                    />
                    <Stat
                      icon={<Activity size={20} />}
                      value={active}
                      label={t("activeProjects")}
                      detail="LIVE LOCALLY"
                      green
                    />
                    <Stat
                      icon={<Box size={20} />}
                      value={
                        snapshot.runtimes.filter((r) => r.installed).length
                      }
                      label={t("installedRuntimes")}
                      detail="READY TO GO"
                    />
                  </div>
                  <div className="dashboard-columns">
                    <section>
                      <div className="section-heading">
                        <h2>
                          {t("recentProjects")}
                          <span>{snapshot.projects.length}</span>
                        </h2>
                        <button
                          className="text-button"
                          onClick={() => navigate("projects")}
                        >
                          {t("viewAll")}
                          <ArrowRight size={15} />
                        </button>
                      </div>
                      <ProjectGrid
                        projects={snapshot.projects.slice(0, 4)}
                        statuses={snapshot.statuses}
                        t={t}
                        onSelect={setSelected}
                        onCreate={() => setWizard("new")}
                        onStart={(id) =>
                          run(() => api.start(id), t("starting"))
                        }
                        onStop={(id) => run(() => api.stop(id), t("stopping"))}
                        busy={busy}
                      />
                    </section>
                    <section className="activity-panel">
                      <div className="section-heading">
                        <h2>{t("activity")}</h2>
                        <span className="small-label">LIVE</span>
                      </div>
                      {events.filter((e) => e.kind !== "progress").length ? (
                        <div className="activity-list">
                          {events
                            .filter((e) => e.kind !== "progress")
                            .slice(-5)
                            .reverse()
                            .map((e, i) => (
                              <div
                                className="activity-item"
                                key={`${e.timestamp}-${i}`}
                              >
                                <span
                                  className={`activity-dot ${e.kind === "error" ? "red" : ""}`}
                                />
                                <div>
                                  <p>{e.message}</p>
                                  <time>
                                    {new Date(e.timestamp).toLocaleTimeString(
                                      [],
                                      { hour: "2-digit", minute: "2-digit" },
                                    )}
                                  </time>
                                </div>
                              </div>
                            ))}
                        </div>
                      ) : (
                        <div className="quiet">
                          <Coffee size={29} strokeWidth={1.3} />
                          <p>{t("noActivity")}</p>
                        </div>
                      )}
                      <div className="activity-footer">
                        <span className="tiny-dot" />
                        {t("ready")}
                      </div>
                    </section>
                  </div>
                  <div className="bottom-note">
                    <ShieldCheck size={15} />
                    {t("privacy")}
                    <span>MADE FOR DEVELOPERS, WITH CARE.</span>
                  </div>
                </>
              )}
              {page === "projects" && (
                <ProjectsPage
                  snapshot={snapshot}
                  t={t}
                  onCreate={() => setWizard("new")}
                  onImport={() => setWizard("import")}
                  onSelect={setSelected}
                  onStart={(id) => run(() => api.start(id), t("starting"))}
                  onStop={(id) => run(() => api.stop(id), t("stopping"))}
                  busy={busy}
                />
              )}
              {page === "runtimes" && (
                <RuntimesPage
                  snapshot={snapshot}
                  t={t}
                  busy={busy}
                  onInstall={(runtime, offline) =>
                    operation(
                      `${t("install")} ${names[runtime.artifact.component]} ${runtime.artifact.version}`,
                      (id) => api.install(runtime.artifact.id, id, offline),
                      true,
                    )
                  }
                  onRemove={(runtime) =>
                    run(() => api.remove(runtime.artifact.id))
                  }
                  run={run}
                />
              )}
              {page === "services" && (
                <>
                  <PageHeading
                    eyebrow="THE ENGINE ROOM"
                    title={t("servicesTitle")}
                    description={t("servicesSub")}
                  />
                  <div className="services-grid">
                    {snapshot.services.map((service) => (
                      <section className="service-card" key={service.id}>
                        <div className="service-top">
                          <div
                            className={`service-icon ${service.id === "caddy" ? "green" : "blue"}`}
                          >
                            {service.id === "caddy" ? (
                              <Server size={26} />
                            ) : (
                              <Database size={26} />
                            )}
                          </div>
                          <StatusBadge state={service.state} t={t} />
                        </div>
                        <h2>{service.name}</h2>
                        <p>{service.detail}</p>
                        <div className="service-spec">
                          <span>127.0.0.1</span>
                          <code>:{service.port}</code>
                          <ShieldCheck size={15} />
                        </div>
                        {!service.installed && (
                          <p className="muted small">{t("notInstalled")}</p>
                        )}
                        <button
                          className="button secondary full"
                          disabled={
                            busy || !service.installed || service.id === "caddy"
                          }
                          onClick={() =>
                            run(() =>
                              service.state === "running"
                                ? api.stopService(service.id)
                                : api.startService(
                                    service.id as DatabaseEngine,
                                  ),
                            )
                          }
                        >
                          {service.state === "running" ? (
                            <Square size={14} />
                          ) : (
                            <Play size={14} />
                          )}
                          {service.state === "running" ? t("stop") : t("start")}
                        </button>
                      </section>
                    ))}
                  </div>
                  {!snapshot.services.length && (
                    <EmptyState
                      icon={<Server />}
                      title={t("services")}
                      description={t("noServices")}
                    />
                  )}
                </>
              )}
              {page === "backups" && (
                <>
                  <PageHeading
                    eyebrow="A SAFE PLACE TO RETURN TO"
                    title={t("backupsTitle")}
                    description={t("backupsSub")}
                  >
                    <button
                      className="button primary"
                      onClick={() => setWizard("restore")}
                    >
                      <Upload size={16} />
                      {t("restore")}
                    </button>
                  </PageHeading>
                  {snapshot.backups.length ? (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>{t("projects")}</th>
                            <th>Created</th>
                            <th>Contents</th>
                            <th>Size</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {snapshot.backups.map((b) => (
                            <tr key={b.id}>
                              <td>
                                <strong>{b.projectName}</strong>
                                <small>{b.id.slice(0, 8)}</small>
                              </td>
                              <td>{new Date(b.createdAt).toLocaleString()}</td>
                              <td>
                                <span className="tag">
                                  Files {b.hasDatabase && "+ database"}
                                </span>
                              </td>
                              <td>{formatBytes(b.bytes)}</td>
                              <td>
                                <button
                                  className="button small secondary"
                                  disabled={busy}
                                  onClick={() =>
                                    run(async () => {
                                      const destination = await saveArchive(
                                        `${b.projectName}-backup.zip`,
                                      );
                                      if (destination)
                                        await api.exportBackup(
                                          b.id,
                                          destination,
                                        );
                                    })
                                  }
                                >
                                  <ArrowDownToLine size={15} />
                                  {t("export")}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <EmptyState
                      icon={<HardDrive />}
                      title={t("noBackups")}
                      description={t("noBackupsSub")}
                    />
                  )}
                </>
              )}
              {page === "settings" && (
                <SettingsPage
                  snapshot={snapshot}
                  t={t}
                  busy={busy}
                  onSave={saveSettings}
                  run={run}
                />
              )}
            </>
          )}
        </main>
      </div>
      {wizard && (
        <ProjectWizard
          mode={wizard}
          t={t}
          busy={busy}
          onClose={() => setWizard(null)}
          onSubmit={async (input) => {
            await run(async () => {
              let project: Project;
              if (input.mode === "new")
                project = await api.create(
                  input.path,
                  input.name,
                  input.preset,
                  input.trusted,
                );
              else if (input.mode === "restore")
                project = await api.restore(
                  input.archive,
                  joinPath(input.path, input.name),
                  input.trusted,
                );
              else
                project = await api.import(
                  input.path,
                  input.spec!,
                  input.trusted,
                );
              setWizard(null);
              setPage("projects");
              setSelected(project.id);
              setNotice(`${project.spec.name} · ${t("configured")}`);
            });
          }}
          onError={setError}
        />
      )}
      {error && (
        <div className="toast error-toast" role="alert">
          <TriangleAlert size={20} />
          <div>
            <strong>Something needs a look</strong>
            <p>{error}</p>
          </div>
          <button
            className="icon-button"
            onClick={() => setError(null)}
            aria-label={t("close")}
          >
            <X size={18} />
          </button>
        </div>
      )}
      {notice && !error && (
        <div className="toast notice-toast" role="status">
          <CircleCheck size={20} />
          <p>{notice}</p>
          <button
            className="icon-button"
            onClick={() => setNotice(null)}
            aria-label={t("close")}
          >
            <X size={17} />
          </button>
        </div>
      )}
      {task && (
        <div className="task-panel" role="status">
          <div>
            <Loader2 className="spin" size={19} />
            <strong>{task.title}</strong>
            {task.cancellable && (
              <button
                className="text-button"
                onClick={() => {
                  void api.cancel(task.id);
                }}
              >
                {t("cancel")}
              </button>
            )}
          </div>
          <div
            className={`progress-track ${task.progress === null ? "indeterminate" : ""}`}
          >
            <span style={{ width: `${task.progress ?? 35}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}

function PageHeading({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <span className="eyebrow muted">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children && <div className="heading-actions">{children}</div>}
    </div>
  );
}
function Stat({
  icon,
  value,
  label,
  detail,
  green,
}: {
  icon: ReactNode;
  value: number;
  label: string;
  detail: string;
  green?: boolean;
}) {
  return (
    <section className="stat-card">
      <div>
        <span className={`stat-icon ${green ? "green" : ""}`}>{icon}</span>
        <span className="small-label">{detail}</span>
      </div>
      <strong>{String(value).padStart(2, "0")}</strong>
      <p>{label}</p>
    </section>
  );
}
function StatusBadge({ state, t }: { state: string; t: T }) {
  const label = [
    "running",
    "stopped",
    "failed",
    "starting",
    "stopping",
  ].includes(state)
    ? t(state as "running")
    : state;
  return (
    <span className={`status-badge ${state}`}>
      <span className="tiny-dot" />
      {label}
    </span>
  );
}
function EmptyState({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
function ProjectGrid({
  projects,
  statuses,
  t,
  onSelect,
  onCreate,
  onStart,
  onStop,
  busy,
}: {
  projects: Project[];
  statuses: ProjectStatus[];
  t: T;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  busy: boolean;
}) {
  if (!projects.length)
    return (
      <EmptyState
        icon={<FolderOpen size={28} strokeWidth={1.4} />}
        title={t("noProjects")}
        description={t("noProjectsSub")}
      >
        <button className="button secondary" onClick={onCreate}>
          <Plus size={16} />
          {t("newProject")}
        </button>
      </EmptyState>
    );
  return (
    <div className="project-grid">
      {projects.map((project) => {
        const preset = presets.find((p) => p.id === project.spec.preset)!;
        const state = projectState(
          statuses.find((s) => s.projectId === project.id),
        );
        return (
          <article className="project-card" key={project.id}>
            <div className="project-card-top">
              <span className={`framework-mark ${preset.color}`}>
                {preset.mark}
              </span>
              <StatusBadge state={state} t={t} />
              <button
                className="icon-button"
                aria-label={`Configure ${project.spec.name}`}
                onClick={() => onSelect(project.id)}
              >
                <MoreHorizontal size={19} />
              </button>
            </div>
            <button
              className="project-title"
              onClick={() => onSelect(project.id)}
            >
              {project.spec.name}
              <ArrowUpRight size={17} />
            </button>
            <p className="project-path" title={project.path}>
              {project.path}
            </p>
            <div className="project-card-bottom">
              <span>
                {preset.name}
                {project.spec.runtimes[0] && (
                  <>
                    <span className="separator-dot">·</span>
                    {project.spec.runtimes[0].version}
                  </>
                )}
              </span>
              <button
                className={`run-button ${state === "running" ? "is-running" : ""}`}
                disabled={busy}
                onClick={() =>
                  state === "running" ? onStop(project.id) : onStart(project.id)
                }
                aria-label={`${state === "running" ? "Stop" : "Start"} ${project.spec.name}`}
              >
                {state === "running" ? (
                  <Square size={12} fill="currentColor" />
                ) : (
                  <Play size={13} fill="currentColor" />
                )}
                {state === "running" ? t("stop") : t("start")}
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
function ProjectsPage({
  snapshot,
  t,
  onCreate,
  onImport,
  onSelect,
  onStart,
  onStop,
  busy,
}: {
  snapshot: Snapshot;
  t: T;
  onCreate: () => void;
  onImport: () => void;
  onSelect: (id: string) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  busy: boolean;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const projects = snapshot.projects.filter(
    (p) =>
      (!search ||
        `${p.spec.name} ${p.path}`
          .toLowerCase()
          .includes(search.toLowerCase())) &&
      (filter === "all" ||
        (filter === "php"
          ? ["php", "laravel"].includes(p.spec.preset)
          : filter === "node"
            ? !["php", "laravel", "static"].includes(p.spec.preset)
            : p.spec.preset === "static")),
  );
  return (
    <>
      <PageHeading
        eyebrow="IDEAS LIVE HERE"
        title={t("projects")}
        description={t("yourStackSub")}
      >
        <button className="button secondary" onClick={onImport}>
          <FolderOpen size={16} />
          {t("importProject")}
        </button>
        <button className="button primary" onClick={onCreate}>
          <Plus size={16} />
          {t("newProject")}
        </button>
      </PageHeading>
      <div className="filter-bar">
        <div className="tabs compact">
          {["all", "php", "node", "static"].map((key) => (
            <button
              className={filter === key ? "active" : ""}
              key={key}
              onClick={() => setFilter(key)}
            >
              {key === "all"
                ? t("all")
                : key === "node"
                  ? "Node.js"
                  : key === "php"
                    ? "PHP"
                    : "Static"}
            </button>
          ))}
        </div>
        <label className="search-field">
          <Search size={17} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("search")}
            aria-label={t("search")}
          />
        </label>
      </div>
      {projects.length || !snapshot.projects.length ? (
        <ProjectGrid
          projects={projects}
          statuses={snapshot.statuses}
          t={t}
          onCreate={onCreate}
          onSelect={onSelect}
          onStart={onStart}
          onStop={onStop}
          busy={busy}
        />
      ) : (
        <p className="muted">{t("noMatch")}</p>
      )}
    </>
  );
}

type Run = (
  action: () => Promise<unknown>,
  title?: string,
  cancellable?: boolean,
) => Promise<void>;
function RuntimesPage({
  snapshot,
  t,
  busy,
  onInstall,
  onRemove,
  run,
}: {
  snapshot: Snapshot;
  t: T;
  busy: boolean;
  onInstall: (runtime: RuntimeInfo, offline: string | null) => void;
  onRemove: (runtime: RuntimeInfo) => void;
  run: Run;
}) {
  const [filter, setFilter] = useState("all");
  const [offline, setOffline] = useState<string | null>(null);
  const groups = useMemo(
    () => [...new Set(snapshot.runtimes.map((r) => r.artifact.component))],
    [snapshot.runtimes],
  );
  return (
    <>
      <PageHeading
        eyebrow="YOUR TOOLBOX"
        title={t("runtimeTitle")}
        description={t("runtimeSub")}
      >
        <button
          className="button secondary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const path = await pickDirectory();
              if (path) setOffline(path);
            })
          }
        >
          <FolderOpen size={16} />
          {t("offline")}
        </button>
      </PageHeading>
      {offline && (
        <div className="inline-alert info">
          <Folder size={17} />
          <span>{offline}</span>
          <button className="text-button" onClick={() => setOffline(null)}>
            {t("close")}
          </button>
        </div>
      )}
      <div className="filter-bar">
        <div className="tabs compact">
          <button
            className={filter === "all" ? "active" : ""}
            onClick={() => setFilter("all")}
          >
            {t("all")}
          </button>
          {groups.map((group) => (
            <button
              key={group}
              className={filter === group ? "active" : ""}
              onClick={() => setFilter(group)}
            >
              {names[group] || group}
            </button>
          ))}
        </div>
        <span className="verified-label">
          <ShieldCheck size={15} />
          {t("verified")}
        </span>
      </div>
      {snapshot.runtimes.length ? (
        <div className="runtime-grid">
          {snapshot.runtimes
            .filter((r) => filter === "all" || r.artifact.component === filter)
            .map((runtime) => (
              <article className="runtime-card" key={runtime.artifact.id}>
                <div className="runtime-card-header">
                  <span
                    className={`framework-mark ${runtime.artifact.component === "php" ? "purple" : runtime.artifact.component === "node" ? "green" : "sand"}`}
                  >
                    {runtime.artifact.component === "php" ? (
                      "php"
                    ) : runtime.artifact.component === "node" ? (
                      "JS"
                    ) : (
                      <Package size={24} />
                    )}
                  </span>
                  {runtime.installed ? (
                    <span className="tag success">
                      <Check size={12} />
                      {t("installed")}
                    </span>
                  ) : (
                    <span className="tag">{runtime.artifact.arch}</span>
                  )}
                </div>
                <h2>
                  {names[runtime.artifact.component] ||
                    runtime.artifact.component}
                  <span>{runtime.artifact.version}</span>
                </h2>
                <p>
                  {runtime.artifact.license}
                  <span className="separator-dot">·</span>
                  {runtime.artifact.platform} / {runtime.artifact.arch}
                </p>
                <div className="runtime-meta">
                  <span>
                    {runtime.installed ? t("installedSize") : t("package")}
                  </span>
                  <strong>
                    {formatBytes(
                      runtime.installed
                        ? runtime.diskBytes
                        : runtime.artifact.size,
                    )}
                  </strong>
                </div>
                <button
                  className={`button full ${runtime.installed ? "secondary" : "primary"}`}
                  disabled={busy}
                  onClick={() =>
                    runtime.installed
                      ? onRemove(runtime)
                      : onInstall(runtime, offline)
                  }
                >
                  {runtime.installed ? (
                    <Trash2 size={15} />
                  ) : (
                    <Download size={15} />
                  )}
                  {runtime.installed ? t("remove") : t("install")}
                </button>
              </article>
            ))}
        </div>
      ) : (
        <EmptyState
          icon={<Package />}
          title={t("noCatalog")}
          description={t("noCatalogSub")}
        />
      )}
    </>
  );
}

function ProjectDetail({
  project,
  snapshot,
  t,
  busy,
  events,
  onBack,
  run,
  onStart,
  onStop,
  onSetup,
  onPrepare,
  onBackup,
  onForget,
}: {
  project: Project;
  snapshot: Snapshot;
  t: T;
  busy: boolean;
  events: AppEvent[];
  onBack: () => void;
  run: Run;
  onStart: () => void;
  onStop: () => void;
  onSetup: () => void;
  onPrepare: () => void;
  onBackup: () => void;
  onForget: () => void;
}) {
  const [tab, setTab] = useState("overview");
  const [spec, setSpec] = useState(project.spec);
  const [trusted, setTrusted] = useState(project.trusted);
  const [commands, setCommands] = useState(
    JSON.stringify(project.spec.processes, null, 2),
  );
  const [environment, setEnvironment] = useState(
    JSON.stringify(project.spec.environment, null, 2),
  );
  const [engine, setEngine] = useState<DatabaseEngine>("sqlite");
  useEffect(() => {
    setSpec(project.spec);
    setTrusted(project.trusted);
    setCommands(JSON.stringify(project.spec.processes, null, 2));
    setEnvironment(JSON.stringify(project.spec.environment, null, 2));
  }, [project.id, project.trusted, JSON.stringify(project.spec)]);
  const status = snapshot.statuses.find((s) => s.projectId === project.id);
  const state = projectState(status);
  const preset = presets.find((p) => p.id === project.spec.preset)!;
  const logs = events.filter((e) => e.subject === project.id);
  return (
    <>
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={16} />
        {t("projects")}
      </button>
      <div className="detail-heading">
        <span className={`framework-mark large ${preset.color}`}>
          {preset.mark}
        </span>
        <div>
          <h1>{project.spec.name}</h1>
          <p>{project.path}</p>
        </div>
        <StatusBadge state={state} t={t} />
        <div className="detail-actions">
          <button
            className="button secondary"
            disabled={busy || state !== "running"}
            onClick={() => run(() => api.open(project.id, "browser"))}
          >
            <ExternalLink size={15} />
            {t("open")}
          </button>
          <button
            className="button primary"
            disabled={busy}
            onClick={state === "running" ? onStop : onStart}
          >
            {busy ? (
              <Loader2 size={15} className="spin" />
            ) : state === "running" ? (
              <Square size={14} />
            ) : (
              <Play size={14} />
            )}
            {state === "running" ? t("stop") : t("start")}
          </button>
        </div>
      </div>
      {!project.trusted && (
        <div className="inline-alert">
          <ShieldCheck size={18} />
          {t("trustRequired")}
          <button
            className="text-button"
            onClick={() => setTab("configuration")}
          >
            {t("configuration")}
            <ArrowRight size={14} />
          </button>
        </div>
      )}
      <div className="tabs detail-tabs">
        {["overview", "logs", "configuration", "database"].map((id) => (
          <button
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
            key={id}
          >
            {id === "overview"
              ? t("details")
              : id === "database"
                ? t("databases")
                : t(id as "logs")}
          </button>
        ))}
      </div>
      {tab === "overview" && (
        <div className="detail-grid">
          <section className="panel">
            <div className="section-heading">
              <h2>{t("process")}</h2>
              <Code2 size={18} />
            </div>
            {project.spec.processes.map((process) => {
              const info = status?.processes.find(
                (p) => p.name === process.name,
              );
              return (
                <div className="process-row" key={process.name}>
                  <Terminal size={18} />
                  <div>
                    <strong>{process.name}</strong>
                    <code>
                      {process.tool} {process.args.join(" ")}
                    </code>
                    {info?.error && <p className="error-text">{info.error}</p>}
                  </div>
                  <StatusBadge state={info?.state || "stopped"} t={t} />
                </div>
              );
            })}
            {[
              ["browser", status?.url],
              ["loopback", status?.fallbackUrl],
            ].map(
              ([target, url]) =>
                url && (
                  <div className="project-url" key={target}>
                    <span className="tiny-dot" />
                    <code>{url}</code>
                    <button
                      className="icon-button"
                      aria-label={`Open ${url}`}
                      onClick={() => run(() => api.open(project.id, target!))}
                    >
                      <ExternalLink size={16} />
                    </button>
                  </div>
                ),
            )}
          </section>
          <section className="panel">
            <div className="section-heading">
              <h2>{t("runtime")}</h2>
              <Layers3 size={18} />
            </div>
            {project.spec.runtimes.map((runtime) => (
              <div className="info-row" key={runtime.component}>
                <span>{names[runtime.component] || runtime.component}</span>
                <code>{runtime.version}</code>
              </div>
            ))}
            <button
              className="button secondary full"
              disabled={busy}
              onClick={onSetup}
            >
              <Download size={15} />
              {t("setupRuntime")}
            </button>
            <button
              className="button secondary full"
              disabled={busy || state === "running" || !project.trusted}
              onClick={onPrepare}
            >
              <Package size={15} />
              {t("dependencies")}
            </button>
          </section>
          <section className="panel">
            <div className="section-heading">
              <h2>Workspace</h2>
              <Folder size={18} />
            </div>
            <div className="quick-actions">
              {[
                { id: "folder", icon: FolderOpen },
                { id: "terminal", icon: Terminal },
                { id: "editor", icon: Code2 },
              ].map(({ id, icon: Icon }) => (
                <button
                  className="button secondary"
                  key={id}
                  disabled={busy}
                  onClick={() => run(() => api.open(project.id, id))}
                >
                  <Icon size={16} />
                  {t(id as "folder")}
                </button>
              ))}
            </div>
          </section>
          <section className="panel">
            <div className="section-heading">
              <h2>{t("backups")}</h2>
              <HardDrive size={18} />
            </div>
            <p className="muted small">{t("backupsSub")}</p>
            <button
              className="button secondary full"
              disabled={busy}
              onClick={onBackup}
            >
              <HardDrive size={15} />
              {t("backup")}
            </button>
          </section>
        </div>
      )}
      {tab === "logs" && (
        <div className="log-view">
          <div className="log-toolbar">
            <span>
              <span className="tiny-dot" />
              {project.spec.name}
            </span>
            <span>{logs.length} entries</span>
          </div>
          <div className="log-lines">
            {logs.length ? (
              logs.map((e, i) => (
                <div
                  className={e.kind === "error" ? "log-error" : ""}
                  key={`${i}-${e.timestamp}`}
                >
                  <time>{new Date(e.timestamp).toLocaleTimeString()}</time>
                  <pre>{e.message}</pre>
                </div>
              ))
            ) : (
              <p className="muted">{t("noLogs")}</p>
            )}
          </div>
        </div>
      )}
      {tab === "configuration" && (
        <section className="panel config-panel">
          <p className="muted small">{t("runtimeHelp")}</p>
          <label className="field">
            {t("name")}
            <input
              value={spec.name}
              onChange={(e) =>
                setSpec((current) => ({ ...current, name: e.target.value }))
              }
            />
          </label>
          {spec.runtimes.map((runtime, index) => (
            <label className="field" key={runtime.component}>
              {names[runtime.component] || runtime.component}
              <select
                value={runtime.version}
                onChange={(e) =>
                  setSpec((current) => ({
                    ...current,
                    runtimes: current.runtimes.map((r, i) =>
                      i === index ? { ...r, version: e.target.value } : r,
                    ),
                  }))
                }
              >
                {[
                  ...new Set([
                    runtime.version,
                    ...snapshot.runtimes
                      .filter((r) => r.artifact.component === runtime.component)
                      .map((r) => r.artifact.version),
                  ]),
                ].map((version) => (
                  <option key={version}>{version}</option>
                ))}
              </select>
            </label>
          ))}
          <label className="field">
            {t("commands")}
            <textarea
              className="code-input"
              rows={11}
              value={commands}
              onChange={(e) => setCommands(e.target.value)}
            />
          </label>
          <label className="field">
            {t("environment")}
            <textarea
              className="code-input"
              rows={5}
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={trusted}
              onChange={(e) => setTrusted(e.target.checked)}
            />
            <span>
              {t("trust")}
              <small>{t("trustSub")}</small>
            </span>
          </label>
          <div className="config-footer">
            <button
              className="button danger"
              disabled={busy}
              onClick={onForget}
            >
              <Trash2 size={15} />
              {t("forget")}
            </button>
            <button
              className="button primary"
              disabled={busy || state === "running"}
              onClick={() =>
                run(() =>
                  api.saveProject(
                    project.id,
                    {
                      ...spec,
                      processes: JSON.parse(commands),
                      environment: JSON.parse(environment),
                    },
                    trusted,
                  ),
                )
              }
            >
              <Check size={16} />
              {t("save")}
            </button>
          </div>
        </section>
      )}
      {tab === "database" && (
        <section className="panel database-panel">
          <Database size={36} strokeWidth={1.3} />
          <h2>
            {project.spec.database
              ? names[project.spec.database.engine] || "SQLite"
              : t("noDb")}
          </h2>
          <p className="muted">{t("dbHelp")}</p>
          {project.spec.database ? (
            <>
              <div className="info-row">
                <span>{t("name")}</span>
                <code>{project.spec.database.name}</code>
              </div>
              <div className="info-row">
                <span>User</span>
                <code>{project.spec.database.username || "Local file"}</code>
              </div>
              <div className="info-row">
                <span>{t("port")}</span>
                <code>{project.spec.database.port || "—"}</code>
              </div>
              <p className="muted small">
                Database connection variables are injected into project
                processes. Passwords stay in the OS keychain.
              </p>
              <DatabaseQuery
                projectId={project.id}
                trusted={project.trusted}
                busy={busy}
                run={run}
              />
            </>
          ) : (
            <div className="form-row">
              <select
                value={engine}
                onChange={(e) => setEngine(e.target.value as DatabaseEngine)}
              >
                <option value="sqlite">SQLite</option>
                <option value="mariadb">MariaDB</option>
                <option value="postgres">PostgreSQL</option>
              </select>
              <button
                className="button primary"
                disabled={busy || !project.trusted || state === "running"}
                onClick={() =>
                  run(
                    () => api.attachDatabase(project.id, engine),
                    t("attachDb"),
                  )
                }
              >
                <Plus size={16} />
                {t("attachDb")}
              </button>
            </div>
          )}
        </section>
      )}
    </>
  );
}

function DatabaseQuery({
  projectId,
  trusted,
  busy,
  run,
}: {
  projectId: string;
  trusted: boolean;
  busy: boolean;
  run: Run;
}) {
  const [sql, setSql] = useState("SELECT 1;");
  const [result, setResult] = useState("");
  return (
    <div className="database-query">
      <label className="field">
        SQL
        <textarea
          className="code-input"
          rows={5}
          value={sql}
          onChange={(event) => setSql(event.target.value)}
        />
      </label>
      <button
        className="button secondary full"
        disabled={busy || !trusted || !sql.trim()}
        onClick={() =>
          run(async () => setResult(await api.queryDatabase(projectId, sql)))
        }
      >
        <Play size={14} />
        Run SQL
      </button>
      {result && <pre className="query-result">{result}</pre>}
    </div>
  );
}
function SettingsPage({
  snapshot,
  t,
  busy,
  onSave,
  run,
}: {
  snapshot: Snapshot;
  t: T;
  busy: boolean;
  onSave: (settings: Settings) => void;
  run: Run;
}) {
  const [settings, setSettings] = useState(snapshot.settings);
  const [checks, setChecks] = useState<Diagnostic[]>([]);
  useEffect(() => {
    setSettings(snapshot.settings);
  }, [JSON.stringify(snapshot.settings)]);
  const update = (change: Partial<Settings>) => {
    const value = { ...settings, ...change };
    setSettings(value);
    onSave(value);
  };
  return (
    <>
      <PageHeading
        eyebrow="SETTLE IN"
        title={t("settingsTitle")}
        description={t("settingsSub")}
      />
      <div className="settings-layout">
        <section className="panel">
          <div className="section-heading">
            <h2>{t("appearance")}</h2>
            <Sun size={18} />
          </div>
          <div className="theme-options">
            {[
              { id: "light", icon: Sun },
              { id: "dark", icon: Moon },
              { id: "system", icon: Monitor },
            ].map(({ id, icon: Icon }) => (
              <button
                key={id}
                className={settings.theme === id ? "selected" : ""}
                onClick={() => update({ theme: id })}
              >
                <div className={`theme-mini ${id}`}>
                  <span />
                  <span />
                  <span />
                </div>
                <Icon size={15} />
                {t(id as "light")}
                {settings.theme === id && <Check size={14} />}
              </button>
            ))}
          </div>
          <label className="field">
            {t("language")}
            <select
              value={settings.language}
              onChange={(e) => update({ language: e.target.value })}
            >
              <option value="en">English</option>
              <option value="th">ภาษาไทย</option>
            </select>
          </label>
        </section>
        <section className="panel">
          <div className="section-heading">
            <h2>{t("behavior")}</h2>
            <Settings2 size={18} />
          </div>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.closeToTray}
              onChange={(e) => update({ closeToTray: e.target.checked })}
            />
            <span>{t("tray")}</span>
          </label>
          <label className="field">
            {t("proxy")}
            <div className="form-row">
              <input
                type="number"
                min="1024"
                max="65535"
                value={settings.proxyPort}
                onChange={(e) =>
                  setSettings((current) => ({
                    ...current,
                    proxyPort: Number(e.target.value),
                  }))
                }
              />
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => onSave(settings)}
              >
                {t("save")}
              </button>
            </div>
          </label>
          <p className="muted small">{t("privacy")}</p>
        </section>
        <section className="panel span-two">
          <div className="section-heading">
            <h2>{t("doctor")}</h2>
            <button
              className="button small secondary"
              disabled={busy || !desktop}
              onClick={() => run(async () => setChecks(await api.doctor()))}
            >
              <RefreshCw size={14} />
              {t("runCheck")}
            </button>
          </div>
          {checks.map((check) => (
            <div className="diagnostic" key={check.id}>
              {check.status === "ok" ? (
                <CircleCheck size={18} className="text-green" />
              ) : (
                <TriangleAlert size={18} className="text-amber" />
              )}
              <div>
                <strong>{check.title}</strong>
                <p>{check.detail}</p>
              </div>
            </div>
          ))}
          {!checks.length && (
            <p className="muted small">
              Check native platform support, storage, signed packages, and
              installed tools.
            </p>
          )}
        </section>
        <section className="panel span-two">
          <div className="section-heading">
            <h2>{t("storage")}</h2>
            <HardDrive size={18} />
          </div>
          <div className="form-row">
            <code className="storage-path">
              {snapshot.dataDirectory || "Available in the desktop app"}
            </code>
            <button
              className="button secondary"
              disabled={!desktop}
              onClick={() => run(() => api.dataOpen())}
            >
              <FolderOpen size={15} />
              {t("openData")}
            </button>
          </div>
        </section>
      </div>
    </>
  );
}

type WizardInput = {
  mode: Exclude<Wizard, null>;
  name: string;
  path: string;
  preset: Preset;
  trusted: boolean;
  spec?: ProjectSpec;
  archive: string;
};
function ProjectWizard({
  mode,
  t,
  busy,
  onClose,
  onSubmit,
  onError,
}: {
  mode: Exclude<Wizard, null>;
  t: T;
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: WizardInput) => Promise<void>;
  onError: (error: string) => void;
}) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [preset, setPreset] = useState<Preset>("node");
  const [trusted, setTrusted] = useState(false);
  const [spec, setSpec] = useState<ProjectSpec>();
  const [archive, setArchive] = useState("");
  const [detecting, setDetecting] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  async function choose() {
    try {
      const folder = await pickDirectory();
      if (!folder) return;
      setPath(folder);
      if (mode === "import") {
        setDetecting(true);
        const detected = await api.detect(folder);
        setSpec(detected);
        setName(detected.name);
        setPreset(detected.preset);
      }
    } catch (e) {
      onError(errorText(e));
    } finally {
      setDetecting(false);
    }
  }
  const valid =
    !!path &&
    (mode === "import"
      ? !!spec
      : !!name.trim() && !/[\\/:]/.test(name) && ![".", ".."].includes(name)) &&
    (mode !== "restore" || !!archive);
  return (
    <dialog
      ref={dialogRef}
      className="modal"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid)
            void onSubmit({ mode, name, path, preset, trusted, spec, archive });
        }}
      >
        <div className="modal-header">
          <div className="modal-icon">
            {mode === "new" ? (
              <Plus size={23} />
            ) : mode === "restore" ? (
              <HardDrive size={23} />
            ) : (
              <FolderOpen size={23} />
            )}
          </div>
          <button
            type="button"
            className="icon-button"
            disabled={busy}
            onClick={onClose}
            aria-label={t("close")}
          >
            <X size={20} />
          </button>
        </div>
        <h2>
          {mode === "new"
            ? t("newProject")
            : mode === "restore"
              ? t("restore")
              : t("importProject")}
        </h2>
        <p className="muted">
          {mode === "new"
            ? t("noProjectsSub")
            : mode === "restore"
              ? t("restoreHelp")
              : t("importHelp")}
        </p>
        {mode === "restore" && (
          <label className="field">
            ZIP archive
            <div className="path-field">
              <input
                readOnly
                value={archive}
                placeholder="Choose a StackCabin backup"
              />
              <button
                type="button"
                className="icon-button"
                onClick={async () => {
                  try {
                    const file = await pickArchive();
                    if (file) setArchive(file);
                  } catch (e) {
                    onError(errorText(e));
                  }
                }}
              >
                <FolderOpen size={18} />
              </button>
            </div>
          </label>
        )}
        {mode !== "import" && (
          <label className="field">
            {mode === "restore" ? t("destination") : t("name")}
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("namePlaceholder")}
              required
            />
          </label>
        )}
        <label className="field">
          {mode === "import" ? t("projectFolder") : t("location")}
          <div className="path-field">
            <input readOnly value={path} placeholder={t("folderPlaceholder")} />
            <button
              type="button"
              className="icon-button"
              onClick={() => {
                void choose();
              }}
              disabled={detecting}
              title={t("choose")}
            >
              {detecting ? (
                <Loader2 className="spin" size={18} />
              ) : (
                <FolderOpen size={18} />
              )}
            </button>
          </div>
        </label>
        {mode === "new" && (
          <>
            <div className="eyebrow template-heading">{t("template")}</div>
            <div className="preset-grid">
              {presets.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className={`preset-choice ${preset === p.id ? "selected" : ""}`}
                  onClick={() => setPreset(p.id)}
                >
                  <span className={`framework-mark mini ${p.color}`}>
                    {p.mark}
                  </span>
                  <span>
                    <strong>{p.name}</strong>
                    <small>{p.description}</small>
                  </span>
                  {preset === p.id && <Check size={14} />}
                </button>
              ))}
            </div>
          </>
        )}
        {mode === "import" && spec && (
          <div className="detected-box">
            <ShieldCheck size={20} />
            <div>
              <strong>
                {presets.find((p) => p.id === preset)?.name} detected
              </strong>
              <p>
                {spec.processes
                  .map((p) => `${p.tool} ${p.args.join(" ")}`)
                  .join(" · ")}
              </p>
            </div>
          </div>
        )}
        <label className="checkbox-label trust-checkbox">
          <input
            type="checkbox"
            checked={trusted}
            onChange={(e) => setTrusted(e.target.checked)}
          />
          <span>
            {t("trust")}
            <small>{t("trustSub")}</small>
          </span>
        </label>
        <div className="modal-footer">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            {t("cancel")}
          </button>
          <button className="button primary" disabled={!valid || busy}>
            {busy ? (
              <Loader2 className="spin" size={16} />
            ) : (
              <ArrowRight size={16} />
            )}
            {mode === "new"
              ? t("create")
              : mode === "restore"
                ? t("restore")
                : t("add")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
function joinPath(parent: string, name: string) {
  return (
    parent.replace(/[\\/]$/, "") + (parent.includes("\\") ? "\\" : "/") + name
  );
}

function CabinIllustration() {
  return (
    <svg
      className="cabin-illustration"
      viewBox="0 0 550 330"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <pattern id="grid" width="30" height="30" patternUnits="userSpaceOnUse">
          <path d="M30 0H0V30" stroke="#c5d2ba" strokeWidth=".5" opacity=".4" />
        </pattern>
        <linearGradient
          id="wall"
          x1="245"
          y1="92"
          x2="370"
          y2="270"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#e8ead7" />
          <stop offset="1" stopColor="#b9c5a8" />
        </linearGradient>
      </defs>
      <rect width="550" height="330" fill="url(#grid)" />
      <ellipse
        cx="299"
        cy="276"
        rx="177"
        ry="28"
        fill="#274f40"
        opacity=".10"
      />
      <path d="m174 170 109 48 151-81-110-47Z" fill="#8fa583" />
      <path d="m183 167 100 46v78l-100-46Z" fill="#c4d1b3" />
      <path d="m283 213 142-76v78l-142 76Z" fill="url(#wall)" />
      <path d="m169 171 110 52 158-87-111-53Z" fill="#295043" />
      <path d="m169 171 110-113 158 78-111-53Z" fill="#3d6754" />
      <path d="m279 58 158 78-112 64-156-29Z" fill="#416d57" />
      <path d="m279 58-110 113 157 29 111-64Z" fill="#476e55" />
      <path
        d="m169 171 110-113 158 78"
        stroke="#173e32"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m169 171 110 52 158-87"
        stroke="#173e32"
        strokeWidth="7"
        strokeLinecap="round"
      />
      <path d="m279 223 47-23 111-64" stroke="#173e32" strokeWidth="5" />
      <path d="m326 200 1-64-48-78" stroke="#173e32" strokeWidth="4" />
      <path
        d="m326 136 111 0M303 97l93 23M280 75l-76 81M298 101l-77 81M313 126l-74 69M325 153l-60 56"
        stroke="#173e32"
        strokeWidth="2"
        opacity=".35"
      />
      <path d="m206 211 32 15v45l-32-15Z" fill="#284c3e" />
      <path d="m210 217 24 11v36l-24-11Z" fill="#163d32" />
      <circle cx="229" cy="246" r="2" fill="#d1d9b2" />
      <path d="m306 226 34-18v30l-34 18Z" fill="#214e3d" />
      <path d="m311 229 24-13v20l-24 13Z" fill="#e1bb6a" />
      <path d="m323 222 0 21m-12-4 24-13" stroke="#38604b" strokeWidth="2" />
      <path d="m365 195 34-18v30l-34 18Z" fill="#214e3d" />
      <path d="m370 198 24-13v20l-24 13Z" fill="#e1bb6a" />
      <path d="m382 191 0 21m-12-4 24-13" stroke="#38604b" strokeWidth="2" />
      <path d="m206 256-18 10 33 16 18-11" fill="#96aa8b" />
      <path d="m191 264-14 9 32 16 13-8" fill="#b3c2a4" />
      <path d="m362 99 0-39 19-10 0 58" fill="#708d71" />
      <path d="m362 60 19-10 13 7-19 10Z" fill="#c6d1b4" />
      <path d="m381 50 13 7v44l-13 7Z" fill="#91a17e" />
      <path
        d="m373 37 0-12m10 3 0-14"
        stroke="#849d80"
        strokeWidth="3"
        strokeLinecap="round"
        opacity=".6"
      />
      <g stroke="#365b43" strokeWidth="3" strokeLinecap="round">
        <path d="M129 217v54m-16-30 16 11 18-17" />
        <path d="m129 171-27 58h54Z" fill="#79996c" />
        <path d="m129 187-32 60h63Z" fill="#65895b" />
        <path d="m129 209-38 58h76Z" fill="#53774c" />
        <path d="M450 200v57m-14-23 14 10 15-12" />
        <path d="m450 154-26 57h52Z" fill="#84a476" />
        <path d="m450 176-32 57h64Z" fill="#6c915f" />
        <path d="m450 199-38 53h76Z" fill="#567e4e" />
      </g>
      <path d="m359 273 20 10 30-16-20-10Z" fill="#a0b390" />
      <path d="m404 251 12 6 18-10-12-6Z" fill="#b1c09e" />
      <path d="m154 285 14 7 20-11-14-7Z" fill="#b1c09e" />
      <rect
        x="65"
        y="80"
        width="88"
        height="43"
        rx="9"
        fill="#f7f7ed"
        stroke="#d3ddc7"
        transform="rotate(-5 65 80)"
      />
      <text
        x="91"
        y="106"
        fill="#7180a5"
        fontFamily="monospace"
        fontWeight="bold"
        fontSize="21"
        transform="rotate(-5 65 80)"
      >
        php
      </text>
      <rect
        x="416"
        y="59"
        width="67"
        height="42"
        rx="9"
        fill="#f7f7ed"
        stroke="#d3ddc7"
        transform="rotate(7 416 59)"
      />
      <text
        x="437"
        y="87"
        fill="#547d45"
        fontFamily="monospace"
        fontWeight="bold"
        fontSize="20"
        transform="rotate(7 416 59)"
      >
        JS
      </text>
      <path
        d="m104 142 14 8m346-22 12-9"
        stroke="#89a080"
        strokeWidth="2"
        strokeDasharray="3 4"
      />
      <circle cx="190" cy="65" r="3" fill="#c3ae6e" />
      <circle cx="467" cy="277" r="3" fill="#c3ae6e" />
      <path
        d="m82 198 7 0m-3.5-3.5v7m382-82h8m-4-4v8"
        stroke="#91a583"
        strokeWidth="2"
      />
    </svg>
  );
}
