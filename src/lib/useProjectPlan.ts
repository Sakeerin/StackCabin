import { useEffect, useState } from "react";
import { api, desktop } from "./api";
import type { Preset, ProjectPlan, ProjectSpec } from "./types";

export type PlanRequest = { preset: Preset; spec?: ProjectSpec; path?: string };
type PlanState = {
  key: string;
  plan: ProjectPlan | null;
  loading: boolean;
  error: string | null;
};

export function useProjectPlan(request: PlanRequest | null) {
  const key = request ? JSON.stringify(request) : "";
  const [state, setState] = useState<PlanState>({
    key: "",
    plan: null,
    loading: false,
    error: null,
  });
  useEffect(() => {
    if (!desktop || !key) {
      setState({ key: "", plan: null, loading: false, error: null });
      return;
    }
    let active = true;
    const request: PlanRequest = JSON.parse(key);
    setState({ key, plan: null, loading: true, error: null });
    api.plan(request.preset, request.spec ?? null, request.path ?? null).then(
      (plan) => {
        if (active) setState({ key, plan, loading: false, error: null });
      },
      (error: unknown) => {
        if (active)
          setState({
            key,
            plan: null,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => {
      active = false;
    };
  }, [key]);
  // Never expose the previous folder/preset's plan while a new request starts.
  const current =
    desktop && key
      ? state.key === key
        ? state
        : { plan: null, loading: true, error: null }
      : { plan: null, loading: false, error: null };
  return { plan: current.plan, loading: current.loading, error: current.error };
}
