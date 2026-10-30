import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { useProjectPlan } from "./useProjectPlan";
import type { Preset, ProjectPlan } from "./types";

vi.mock("./api", () => ({ desktop: true, api: { plan: vi.fn() } }));
afterEach(() => vi.resetAllMocks());

describe("native setup review", () => {
  it("inspects again when the same review is reopened instead of reusing a previous result", async () => {
    let finish!: (plan: ProjectPlan) => void;
    const plan: ProjectPlan = { requirements: [], commands: [], processes: [] };
    vi.mocked(api.plan)
      .mockResolvedValueOnce(plan)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const { result, rerender } = renderHook(
      ({ open }) => useProjectPlan(open ? { preset: "node" } : null),
      { initialProps: { open: true } },
    );
    await waitFor(() => expect(result.current.plan).not.toBeNull());
    rerender({ open: false });
    rerender({ open: true });
    expect(result.current.plan).toBeNull();
    expect(result.current.loading).toBe(true);
    await act(async () => {
      finish(plan);
    });
    await waitFor(() => expect(result.current.plan).not.toBeNull());
    expect(api.plan).toHaveBeenCalledTimes(2);
  });
  it("discards a late result for the previous template", async () => {
    let finishOld!: (plan: ProjectPlan) => void;
    let finishNew!: (plan: ProjectPlan) => void;
    vi.mocked(api.plan)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishNew = resolve;
          }),
      );
    const { result, rerender } = renderHook(
      ({ preset }: { preset: Preset }) => useProjectPlan({ preset }),
      { initialProps: { preset: "node" as Preset } },
    );
    rerender({ preset: "laravel" });
    const empty: ProjectPlan = {
      requirements: [],
      commands: [],
      processes: [],
    };
    await act(async () => {
      finishOld(empty);
    });
    expect(result.current.plan).toBeNull();
    expect(result.current.loading).toBe(true);
    await act(async () => {
      finishNew({
        ...empty,
        commands: [{ tool: "composer", args: ["install"], condition: null }],
      });
    });
    await waitFor(() =>
      expect(result.current.plan?.commands[0].tool).toBe("composer"),
    );
  });
  it("clears the previous plan and exposes an error when a different folder fails inspection", async () => {
    vi.mocked(api.plan)
      .mockResolvedValueOnce({ requirements: [], commands: [], processes: [] })
      .mockRejectedValueOnce(new Error("Folder removed"));
    const { result, rerender } = renderHook(
      ({ path }) => useProjectPlan({ preset: "node", path }),
      { initialProps: { path: "first" } },
    );
    await waitFor(() => expect(result.current.plan).not.toBeNull());
    rerender({ path: "second" });
    await waitFor(() => expect(result.current.error).toBe("Folder removed"));
    expect(result.current.plan).toBeNull();
  });
});
