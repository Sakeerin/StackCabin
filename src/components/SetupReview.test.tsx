import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { translator } from "../lib/i18n";
import type { ProjectPlan } from "../lib/types";
import { SetupReview } from "./SetupReview";

const plan: ProjectPlan = {
  requirements: [
    {
      component: "node",
      version: "24.0.0",
      artifactId: "node-24",
      installed: true,
      downloadBytes: 1,
    },
    {
      component: "php",
      version: "8.5",
      artifactId: null,
      installed: false,
      downloadBytes: 0,
    },
  ],
  commands: [{ tool: "npm", args: ["ci"], condition: "generated-lockfile" }],
  processes: [
    {
      name: "web",
      tool: "node",
      args: ["server.mjs"],
      cwd: ".",
      port: 3000,
      healthPath: "/",
    },
  ],
};

describe("setup review presentation", () => {
  it("separates installed and unavailable packages and shows dependency and process commands", () => {
    render(
      <SetupReview
        plan={plan}
        loading={false}
        error={null}
        t={translator("en")}
      />,
    );
    expect(screen.getByText("Installed")).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByText("npm ci")).toBeInTheDocument();
    expect(screen.getByText("node server.mjs")).toBeInTheDocument();
    expect(
      screen.getByText(/Some packages are unavailable/),
    ).toBeInTheDocument();
  });
  it("explains generated lockfile conditions in Thai without changing the commands", () => {
    render(
      <SetupReview
        plan={plan}
        loading={false}
        error={null}
        t={translator("th")}
      />,
    );
    expect(
      screen.getByRole("region", { name: "ตรวจสอบการตั้งค่าโปรเจกต์" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "เมื่อโปรเจกต์ที่สร้างมี package.json และ package-lock.json",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("npm ci")).toBeInTheDocument();
  });
});
