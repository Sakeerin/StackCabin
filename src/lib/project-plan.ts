import type { ProjectPlan } from "./types";

export function runtimeInstallations(plan: ProjectPlan): string[] {
  const unavailable = plan.requirements.filter((r) => !r.artifactId);
  if (unavailable.length)
    throw new Error(
      `No verified packages available: ${unavailable.map((r) => `${r.component} ${r.version}`).join(", ")}`,
    );
  return [
    ...new Set(
      plan.requirements.filter((r) => !r.installed).map((r) => r.artifactId!),
    ),
  ];
}

export function commandText(tool: string, args: string[]): string {
  return [
    tool,
    ...args.map((arg) =>
      /^[\w./:@${}-]+$/.test(arg) ? arg : JSON.stringify(arg),
    ),
  ].join(" ");
}
