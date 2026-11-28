import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api, emptySnapshot, pickDirectory, subscribe } from "./lib/api";
import type {
  AppEvent,
  ProcessState,
  Project,
  ProjectPlan,
  RuntimeInfo,
} from "./lib/types";
import App from "./App";

vi.mock("./lib/api", async (original) => ({
  ...(await original<typeof import("./lib/api")>()),
  desktop: true,
  pickDirectory: vi.fn(),
  api: {
    snapshot: vi.fn(),
    detect: vi.fn(),
    template: vi.fn(),
    create: vi.fn(),
    import: vi.fn(),
    plan: vi.fn(),
    saveProject: vi.fn(),
    prepare: vi.fn(),
    install: vi.fn(),
    logs: vi.fn().mockResolvedValue([]),
    queryDatabase: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
  },
  subscribe: vi.fn().mockResolvedValue(() => {}),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

function databaseProject(id: string): Project {
  return {
    id,
    path: `D:/${id}`,
    trusted: true,
    createdAt: "2026-11-24",
    spec: {
      schemaVersion: 1,
      name: id,
      preset: "static",
      runtimes: [],
      processes: [],
      environment: {},
      database: { engine: "sqlite", name: "app.sqlite", username: "", port: 0 },
    },
  };
}

function catalogRuntime(component: string, version: string): RuntimeInfo {
  return {
    artifact: {
      id: component + "-" + version,
      component,
      version,
      platform: "windows",
      arch: "x64",
      url: "",
      sha256: "",
      archive: "zip",
      stripComponents: 0,
      executables: {},
      license: "",
      sourceUrl: "",
      size: 1,
    },
    installed: false,
    path: null,
    diskBytes: 0,
  };
}

it("creates a Laravel starter with the two runtime pins last reviewed", async () => {
  const path = "D:/งาน ใหม่";
  const template: Project["spec"] = {
    ...databaseProject("preview").spec,
    preset: "laravel",
    database: null,
    runtimes: [
      { component: "php", version: "8.5" },
      { component: "node", version: "24" },
    ],
  };
  const plan: ProjectPlan = { requirements: [], processes: [], commands: [] };
  vi.mocked(api.snapshot).mockResolvedValue({
    ...emptySnapshot,
    runtimes: [
      catalogRuntime("php", "8.4.1"),
      catalogRuntime("node", "22.1.0"),
    ],
  });
  vi.mocked(api.template).mockImplementation(async (preset) =>
    preset === "laravel"
      ? template
      : {
          ...template,
          preset,
          runtimes: [{ component: "node", version: "24" }],
        },
  );
  vi.mocked(api.plan).mockResolvedValue(plan);
  vi.mocked(pickDirectory).mockResolvedValueOnce(path);
  vi.mocked(api.create).mockResolvedValueOnce(databaseProject("ร้าน"));
  render(<App />);
  fireEvent.click(screen.getAllByRole("button", { name: "New project" })[0]);
  const dialog = within(screen.getByRole("dialog"));
  fireEvent.click(dialog.getByRole("button", { name: /Laravel/ }));
  fireEvent.change(dialog.getByPlaceholderText("my-next-idea"), {
    target: { value: "ร้าน" },
  });
  fireEvent.click(dialog.getByTitle("Choose folder"));
  const php = await dialog.findByRole("combobox", { name: "PHP" });
  expect(php).toHaveValue("8.5");
  expect(dialog.getByRole("combobox", { name: "Node.js" })).toHaveValue("24");
  fireEvent.change(php, { target: { value: "8.4.1" } });
  const trust = dialog.getByRole("checkbox");
  await waitFor(() => expect(trust).toBeEnabled());
  fireEvent.click(trust);
  let finish!: (plan: ProjectPlan) => void;
  vi.mocked(api.plan).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  fireEvent.change(dialog.getByRole("combobox", { name: "Node.js" }), {
    target: { value: "22.1.0" },
  });
  expect(trust).not.toBeChecked();
  expect(trust).toBeDisabled();
  const pins = [
    { component: "php", version: "8.4.1" },
    { component: "node", version: "22.1.0" },
  ];
  expect(api.plan).toHaveBeenLastCalledWith(
    "laravel",
    { ...template, runtimes: pins },
    null,
  );
  await act(async () => finish(plan));
  fireEvent.click(trust);
  fireEvent.click(dialog.getByRole("button", { name: "Create project" }));
  await waitFor(() =>
    expect(api.create).toHaveBeenCalledExactlyOnceWith(
      path,
      "ร้าน",
      "laravel",
      true,
      pins,
    ),
  );
  expect(api.prepare).not.toHaveBeenCalled();
});

it("drops a starter's edits and ignores its late template response after switching to Static", async () => {
  const base = { ...databaseProject("preview").spec, database: null };
  vi.mocked(api.snapshot).mockResolvedValue({
    ...emptySnapshot,
    runtimes: [catalogRuntime("node", "22.1.0")],
  });
  let failLaravel!: (error: Error) => void;
  vi.mocked(api.template).mockImplementation((preset) =>
    preset === "laravel"
      ? new Promise((_, reject) => {
          failLaravel = reject;
        })
      : Promise.resolve({
          ...base,
          preset,
          runtimes:
            preset === "node" ? [{ component: "node", version: "24" }] : [],
        }),
  );
  vi.mocked(api.plan).mockResolvedValue({
    requirements: [],
    commands: [],
    processes: [],
  });
  render(<App />);
  fireEvent.click(screen.getAllByRole("button", { name: "New project" })[0]);
  const dialog = within(screen.getByRole("dialog"));
  fireEvent.change(await dialog.findByRole("combobox", { name: "Node.js" }), {
    target: { value: "22.1.0" },
  });
  await waitFor(() => expect(dialog.getByRole("checkbox")).toBeEnabled());
  fireEvent.click(dialog.getByRole("checkbox"));
  fireEvent.click(dialog.getByRole("button", { name: /Laravel/ }));
  expect(dialog.getByRole("checkbox")).toBeDisabled();
  fireEvent.click(dialog.getByRole("button", { name: /Static/ }));
  await waitFor(() => expect(dialog.getByRole("checkbox")).toBeEnabled());
  await act(async () => failLaravel(new Error("Old template error")));
  expect(dialog.queryByRole("alert")).toBeNull();
  expect(dialog.queryByRole("combobox")).toBeNull();
  expect(dialog.getByRole("checkbox")).not.toBeChecked();
  expect(api.plan).toHaveBeenLastCalledWith(
    "static",
    { ...base, preset: "static" },
    null,
  );
});

it("reviews independent runtime choices for an import and clears trust when a pin changes", async () => {
  const project = databaseProject("ร้านค้า");
  project.path = "D:/โปรเจกต์ ทดสอบ/ร้านค้า";
  project.spec.preset = "laravel";
  project.spec.environment = { APP_ENV: "local" };
  project.spec.runtimes = [
    { component: "php", version: "8.5" },
    { component: "node", version: "20.1.0" },
  ];
  const plan: ProjectPlan = {
    requirements: [],
    processes: [],
    commands: [{ tool: "yarn", args: ["install"], condition: null }],
  };
  vi.mocked(api.snapshot).mockResolvedValue({
    ...emptySnapshot,
    settings: { ...emptySnapshot.settings, language: "th" },
    runtimes: [
      catalogRuntime("php", "8.4.1"),
      catalogRuntime("node", "22.1.0"),
    ],
  });
  vi.mocked(pickDirectory).mockResolvedValueOnce(project.path);
  vi.mocked(api.detect).mockResolvedValueOnce(project.spec);
  vi.mocked(api.plan).mockResolvedValue(plan);
  vi.mocked(api.import).mockResolvedValueOnce(project);
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: "นำเข้าโปรเจกต์" }),
  );
  const dialog = within(screen.getByRole("dialog"));
  fireEvent.click(dialog.getByTitle("เลือกโฟลเดอร์"));
  await dialog.findByText("yarn install");
  expect(dialog.getByText("ประเภทโปรเจกต์ที่ตรวจพบ · Laravel")).toBeVisible();
  const php = dialog.getByRole("combobox", { name: "PHP" });
  const node = dialog.getByRole("combobox", { name: "Node.js" });
  expect(node).toHaveValue("20.1.0");
  expect(within(php).queryByRole("option", { name: "22.1.0" })).toBeNull();
  fireEvent.change(php, { target: { value: "8.4.1" } });
  await dialog.findByText("yarn install");
  fireEvent.click(dialog.getByRole("checkbox"));
  let finish!: (plan: ProjectPlan) => void;
  vi.mocked(api.plan).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  fireEvent.change(node, { target: { value: "22.1.0" } });
  expect(dialog.getByRole("checkbox")).not.toBeChecked();
  expect(dialog.getByRole("checkbox")).toBeDisabled();
  expect(
    within(node).getByRole("option", { name: "20.1.0" }),
  ).toBeInTheDocument();
  const expected = {
    ...project.spec,
    runtimes: [
      { component: "php", version: "8.4.1" },
      { component: "node", version: "22.1.0" },
    ],
  };
  expect(api.plan).toHaveBeenLastCalledWith("laravel", expected, project.path);
  await act(async () => finish(plan));
  fireEvent.click(dialog.getByRole("checkbox"));
  fireEvent.click(dialog.getByRole("button", { name: "เพิ่มโปรเจกต์" }));
  await waitFor(() =>
    expect(api.import).toHaveBeenCalledExactlyOnceWith(
      project.path,
      expected,
      true,
    ),
  );
  expect(api.prepare).not.toHaveBeenCalled();
});

it("keeps the reviewed import on picker cancellation and discards it when another folder fails detection", async () => {
  vi.mocked(api.snapshot).mockResolvedValue(emptySnapshot);
  vi.mocked(pickDirectory)
    .mockResolvedValueOnce("D:/first")
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce("D:/second");
  vi.mocked(api.detect)
    .mockResolvedValueOnce(databaseProject("first").spec)
    .mockRejectedValueOnce(new Error("Invalid project manifest"));
  vi.mocked(api.plan).mockResolvedValue({
    processes: [],
    commands: [],
    requirements: [],
  });
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Import project" }),
  );
  const dialog = within(screen.getByRole("dialog"));
  const choose = dialog.getByTitle("Choose folder");
  const trust = dialog.getByRole("checkbox");
  fireEvent.click(choose);
  await waitFor(() => expect(trust).toBeEnabled());
  expect(dialog.queryByRole("combobox")).toBeNull();
  fireEvent.click(trust);
  fireEvent.click(choose);
  await waitFor(() => expect(choose).toBeEnabled());
  expect(trust).toBeChecked();
  expect(api.detect).toHaveBeenCalledTimes(1);
  fireEvent.click(choose);
  await screen.findByText("Invalid project manifest");
  expect(trust).not.toBeChecked();
  expect(dialog.getByRole("button", { name: "Add project" })).toBeDisabled();
  expect(api.import).not.toHaveBeenCalled();
});

it("restarts the selected running project once and disables duplicate actions until it finishes", async () => {
  const project = databaseProject("shop");
  const status = {
    projectId: project.id,
    url: null,
    fallbackUrl: null,
    processes: [
      {
        name: "web",
        pid: 2,
        state: "running" as const,
        port: 3030,
        url: null,
        error: null,
      },
    ],
  };
  vi.mocked(api.snapshot).mockResolvedValue({
    ...emptySnapshot,
    projects: [project],
    statuses: [status],
  });
  let finish!: (value: typeof status) => void;
  vi.mocked(api.restart).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(<App />);
  fireEvent.click(
    await screen.findByText("shop", { selector: ".project-title" }),
  );
  const restart = screen.getByRole("button", { name: "Restart" });
  fireEvent.click(restart);
  expect(restart).toBeDisabled();
  fireEvent.click(restart);
  expect(api.restart).toHaveBeenCalledExactlyOnceWith("shop");
  await act(async () => finish(status));
  expect(restart).toBeEnabled();
});

it("offers Stop and Restart on a Thai dashboard card while a sibling still runs", async () => {
  const project = databaseProject("shop");
  const web = {
    name: "web",
    state: "running" as const,
    pid: 42,
    port: 3000,
    url: null,
    error: null,
  };
  vi.mocked(api.snapshot).mockResolvedValue({
    ...emptySnapshot,
    settings: { ...emptySnapshot.settings, language: "th" },
    projects: [project],
    statuses: [
      {
        projectId: project.id,
        url: null,
        fallbackUrl: null,
        processes: [web, { ...web, name: "vite", state: "stopped", pid: null }],
      },
    ],
  });
  render(<App />);
  expect(
    await screen.findByRole("button", { name: "เริ่มใหม่ shop" }),
  ).toBeEnabled();
  expect(screen.getByText("ต้องตรวจสอบ")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "หยุด shop" }));
  await waitFor(() =>
    expect(api.stop).toHaveBeenCalledExactlyOnceWith(project.id),
  );
  expect(api.start).not.toHaveBeenCalled();
});

it.each(["starting", "stopping"] as const)(
  "blocks a duplicate action while a project is %s",
  async (state) => {
    const project = databaseProject("shop");
    const process = {
      name: "web",
      state,
      pid: null,
      port: null,
      url: null,
      error: null,
    };
    vi.mocked(api.snapshot).mockResolvedValue({
      ...emptySnapshot,
      projects: [project, { ...databaseProject("untrusted"), trusted: false }],
      statuses: [
        {
          projectId: project.id,
          url: null,
          fallbackUrl: null,
          processes: [process],
        },
      ],
    });
    render(<App />);
    const label = state === "starting" ? "Starting" : "Stopping";
    expect(
      await screen.findByRole("button", { name: `${label} shop` }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Start untrusted" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Restart shop" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("shop", { selector: ".project-title" }));
    expect(screen.getByRole("button", { name: label })).toBeDisabled();
  },
);

it.each([
  ["running", true],
  ["stopped", false],
] as const)(
  "shows supervisor errors and gates project changes when a sibling is %s",
  async (siblingState: ProcessState, active: boolean) => {
    const project = databaseProject("shop");
    project.spec.database = null;
    project.spec.processes = [
      {
        name: "web",
        tool: "node",
        args: ["server.mjs"],
        cwd: ".",
        port: 3000,
        healthPath: "/",
      },
    ];
    const web = {
      name: "web",
      state: siblingState,
      pid: null,
      port: null,
      url: null,
      error: null,
    };
    vi.mocked(api.snapshot).mockResolvedValue({
      ...emptySnapshot,
      projects: [project],
      statuses: [
        {
          projectId: project.id,
          url: null,
          fallbackUrl: null,
          processes: [
            web,
            { ...web, state: "failed", error: "Web route returned 503" },
            {
              ...web,
              name: "local-proxy",
              state: "failed",
              error: "Caddy stopped unexpectedly.",
            },
          ],
        },
      ],
    });
    vi.mocked(api.plan).mockResolvedValue({
      requirements: [],
      processes: [],
      commands: [],
    });
    render(<App />);
    fireEvent.click(
      await screen.findByText("shop", { selector: ".project-title" }),
    );
    expect(screen.getByText(/Web route returned 503/)).toBeVisible();
    expect(screen.getByText(/Caddy stopped unexpectedly/)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Install dependencies" }),
    ).toHaveProperty("disabled", active);
    fireEvent.click(screen.getByRole("button", { name: "Configuration" }));
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty(
      "disabled",
      active,
    );
    fireEvent.click(screen.getByRole("button", { name: "Database" }));
    expect(
      screen.getByRole("button", { name: "Create project database" }),
    ).toHaveProperty("disabled", active);
  },
);

it("merges overlapping history and live events once in sequence for each project", async () => {
  const projects = ["shop", "blog"].map(databaseProject);
  vi.mocked(api.snapshot).mockResolvedValue({ ...emptySnapshot, projects });
  let registered!: (unlisten: () => void) => void;
  vi.mocked(subscribe).mockReturnValueOnce(
    new Promise((resolve) => {
      registered = resolve;
    }),
  );
  let finishHistory!: (events: AppEvent[]) => void;
  vi.mocked(api.logs).mockReturnValueOnce(
    new Promise((resolve) => {
      finishHistory = resolve;
    }),
  );
  const view = render(<App />);
  expect(api.logs).not.toHaveBeenCalled();
  const unlisten = vi.fn();
  await act(async () => registered(unlisten));
  expect(api.logs).toHaveBeenCalledWith(null);
  const receive = vi.mocked(subscribe).mock.calls[0][0];
  const line = (
    sequence: number,
    message: string,
    subject = "shop",
  ): AppEvent => ({
    sequence,
    subject,
    message,
    kind: "log",
    operationId: "",
    progress: null,
    timestamp: "2026-11-24T12:00:00Z",
  });
  act(() => {
    receive(line(5, "last line"));
    receive(line(3, "same line"));
    receive(line(4, "blog only", "blog"));
  });
  await act(async () =>
    finishHistory([
      line(1, "first line"),
      line(2, "same line"),
      line(3, "same line"),
    ]),
  );
  fireEvent.click(screen.getByText("shop", { selector: ".project-title" }));
  fireEvent.click(screen.getByRole("button", { name: "Logs" }));
  expect(
    Array.from(
      view.container.querySelectorAll(".log-lines pre"),
      (el) => el.textContent,
    ),
  ).toEqual(["first line", "same line", "same line", "last line"]);
  fireEvent.click(screen.getByRole("button", { name: "StackCabin home" }));
  fireEvent.click(screen.getByText("blog", { selector: ".project-title" }));
  fireEvent.click(screen.getByRole("button", { name: "Logs" }));
  expect(
    Array.from(
      view.container.querySelectorAll(".log-lines pre"),
      (el) => el.textContent,
    ),
  ).toEqual(["blog only"]);
  view.unmount();
  expect(unlisten).toHaveBeenCalledOnce();
});

it("clears the last SQL result on retry and keeps a late reply with its original project", async () => {
  const projects = ["shop", "blog"].map(databaseProject);
  vi.mocked(api.snapshot).mockResolvedValue({ ...emptySnapshot, projects });
  let finishQuery!: (result: string) => void;
  vi.mocked(api.queryDatabase)
    .mockResolvedValueOnce("shop row")
    .mockRejectedValueOnce(new Error("invalid column"))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishQuery = resolve;
        }),
    )
    .mockResolvedValueOnce("");
  render(<App />);
  fireEvent.click(
    await screen.findByText("shop", { selector: ".project-title" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Database" }));
  const run = screen.getByRole("button", { name: "Run SQL" });
  fireEvent.click(run);
  expect(await screen.findByText("shop row")).toBeInTheDocument();
  fireEvent.click(run);
  expect(await screen.findByText("invalid column")).toBeInTheDocument();
  expect(screen.queryByText("shop row")).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "SQL" }), {
    target: { value: "SELECT 2" },
  });
  fireEvent.click(run);
  expect(api.queryDatabase).toHaveBeenLastCalledWith("shop", "SELECT 2");
  fireEvent.click(screen.getByRole("button", { name: "StackCabin home" }));
  fireEvent.click(screen.getByText("blog", { selector: ".project-title" }));
  fireEvent.click(screen.getByRole("button", { name: "Database" }));
  await act(async () => finishQuery("late shop row"));
  expect(screen.queryByText("late shop row")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Run SQL" }));
  expect(api.queryDatabase).toHaveBeenLastCalledWith("blog", "SELECT 1;");
  expect(
    await screen.findByText("Query completed with no output."),
  ).toBeInTheDocument();
});

it.each(["older success", "older failure", "newer failure"])(
  "ignores out-of-order snapshot results: %s",
  async (scenario) => {
    vi.useFakeTimers();
    type State = Awaited<ReturnType<typeof api.snapshot>>;
    let finishFirst!: (value: State) => void;
    let failFirst!: (reason: Error) => void;
    let finishSecond!: (value: State) => void;
    let failSecond!: (reason: Error) => void;
    const first = new Promise<State>((resolve, reject) => {
      finishFirst = resolve;
      failFirst = reject;
    });
    const second = new Promise<State>((resolve, reject) => {
      finishSecond = resolve;
      failSecond = reject;
    });
    const state = (name: string): State => ({
      ...emptySnapshot,
      projects: [
        {
          id: "snapshot-project",
          path: "D:/snapshot-project",
          trusted: true,
          createdAt: "2026-11-20",
          spec: {
            schemaVersion: 1,
            name,
            preset: "static",
            runtimes: [],
            processes: [],
            environment: {},
            database: null,
          },
        },
      ],
    });
    vi.mocked(api.snapshot)
      .mockReset()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
      .mockResolvedValue(emptySnapshot);
    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(api.snapshot).toHaveBeenCalledTimes(2);
    await act(async () => {
      if (scenario === "newer failure")
        failSecond(new Error("latest refresh failed"));
      else finishSecond(state("current-project"));
    });
    await act(async () => {
      if (scenario === "older failure")
        failFirst(new Error("outdated refresh failed"));
      else finishFirst(state("outdated-project"));
    });
    expect(
      screen.queryByText("outdated-project", { selector: ".project-title" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("outdated refresh failed"),
    ).not.toBeInTheDocument();
    if (scenario === "newer failure") {
      expect(screen.getByText("latest refresh failed")).toBeInTheDocument();
      expect(
        screen.queryByText("current-project", { selector: ".project-title" }),
      ).not.toBeInTheDocument();
    } else {
      expect(
        screen.getByText("current-project", { selector: ".project-title" }),
      ).toBeInTheDocument();
    }
  },
);

it("waits for explicit trust to be saved before preparation; cancelling a review does neither", async () => {
  const project: Project = {
    id: "approval-id",
    path: "D:/approval-project",
    trusted: false,
    createdAt: "2026-10-30",
    spec: {
      schemaVersion: 1,
      name: "approval-project",
      preset: "node",
      runtimes: [{ component: "node", version: "24.0.0" }],
      processes: [
        {
          name: "web",
          tool: "npm",
          args: ["run", "dev"],
          cwd: ".",
          port: 3000,
          healthPath: "/",
        },
      ],
      environment: {},
      database: null,
    },
  };
  const plan: ProjectPlan = {
    requirements: [
      {
        component: "node",
        version: "24.0.0",
        artifactId: "node-24",
        installed: true,
        downloadBytes: 1,
      },
    ],
    commands: [{ tool: "npm", args: ["install"], condition: null }],
    processes: project.spec.processes,
  };
  vi.mocked(api.snapshot).mockResolvedValue({
    ...emptySnapshot,
    projects: [project],
  });
  vi.mocked(api.plan).mockResolvedValue(plan);
  vi.mocked(api.prepare).mockResolvedValue(undefined);
  let finishTrust!: (project: Project) => void;
  vi.mocked(api.saveProject).mockImplementation(
    () =>
      new Promise((resolve) => {
        finishTrust = resolve;
      }),
  );
  render(<App />);
  fireEvent.click(
    await screen.findByText("approval-project", { selector: ".project-title" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Install dependencies" }));
  let dialog = within(screen.getByRole("dialog"));
  await dialog.findByText("npm install");
  expect(dialog.getByRole("checkbox")).not.toBeChecked();
  expect(dialog.getByRole("button", { name: "Continue" })).toBeDisabled();
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  expect(api.saveProject).not.toHaveBeenCalled();
  expect(api.prepare).not.toHaveBeenCalled();
  expect(api.install).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Install dependencies" }));
  dialog = within(screen.getByRole("dialog"));
  await dialog.findByText("npm install");
  fireEvent.click(dialog.getByRole("checkbox"));
  fireEvent.click(dialog.getByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(api.saveProject).toHaveBeenCalledWith(
      project.id,
      project.spec,
      true,
    ),
  );
  expect(api.prepare).not.toHaveBeenCalled();
  await act(async () => {
    finishTrust({ ...project, trusted: true });
  });
  await waitFor(() =>
    expect(api.prepare).toHaveBeenCalledWith(project.id, expect.any(String)),
  );
});
