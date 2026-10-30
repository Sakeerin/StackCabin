import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api, emptySnapshot } from "./lib/api";
import type { Project, ProjectPlan } from "./lib/types";
import App from "./App";

vi.mock("./lib/api", async (original) => ({
  ...(await original<typeof import("./lib/api")>()),
  desktop: true,
  api: {
    snapshot: vi.fn(),
    plan: vi.fn(),
    saveProject: vi.fn(),
    prepare: vi.fn(),
    install: vi.fn(),
    logs: vi.fn().mockResolvedValue([]),
  },
  subscribe: vi.fn().mockResolvedValue(() => {}),
}));
afterEach(() => vi.clearAllMocks());

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
