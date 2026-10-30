import { describe, expect, it } from "vitest";
import { commandText, runtimeInstallations } from "./project-plan";
import type { ProjectPlan, RuntimeRequirement } from "./types";

function plan(requirements: RuntimeRequirement[]): ProjectPlan {
  return { requirements, commands: [], processes: [] };
}
const node: RuntimeRequirement = {
  component: "node",
  version: "24.0.0",
  artifactId: "node-24",
  installed: false,
  downloadBytes: 100,
};

describe("project runtime preflight", () => {
  it("rejects a missing requirement before returning any downloads", () => {
    expect(() =>
      runtimeInstallations(
        plan([node, { ...node, component: "php", artifactId: null }]),
      ),
    ).toThrow(/No verified packages.*php/);
  });
  it("skips installed tools and never schedules duplicate downloads", () => {
    expect(
      runtimeInstallations(
        plan([
          node,
          node,
          { ...node, artifactId: "existing", installed: true },
        ]),
      ),
    ).toEqual(["node-24"]);
  });
  it("shows argument boundaries instead of ambiguous shell text", () => {
    expect(
      commandText("node", [
        "server.mjs",
        "hello world",
        'say "hi"',
        "line\nbreak",
      ]),
    ).toBe(
      String.raw`node server.mjs "hello world" "say \"hi\"" "line\nbreak"`,
    );
  });
});
