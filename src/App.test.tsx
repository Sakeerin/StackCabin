import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App, { formatBytes, projectState } from "./App";

describe("workspace preview", () => {
  it("never represents a browser preview as a connected native workspace", () => {
    render(<App />);
    expect(
      screen.getByText(/Launch the desktop app to manage files/),
    ).toBeInTheDocument();
    expect(screen.getByText("Room for your next idea.")).toBeInTheDocument();
    expect(screen.queryByText("Native desktop")).not.toBeInTheDocument();
  });
  it("exposes every starter and keeps new projects untrusted until explicitly selected", () => {
    render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: /New project/ })[0]);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    for (const name of [
      "PHP",
      "Laravel",
      "Node.js",
      "Express",
      "Vue",
      "React",
      "NestJS",
      "Next.js",
      "Static",
    ])
      expect(
        screen.getByText(name, { selector: ".preset-choice strong" }),
      ).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Create project" }),
    ).toBeDisabled();
  });
  it("switches the interface into Thai and applies dark mode without inventing native state", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.change(screen.getByLabelText("Language"), {
      target: { value: "th" },
    });
    expect(screen.getByText("ปรับพื้นที่ให้เป็นของคุณ")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "มืด" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
describe("real process state presentation", () => {
  it("reports a failed process even when its sibling is healthy", () => {
    expect(
      projectState({
        projectId: "one",
        url: null,
        fallbackUrl: null,
        processes: [
          {
            name: "web",
            state: "running",
            pid: 1,
            port: 3000,
            url: null,
            error: null,
          },
          {
            name: "vite",
            state: "failed",
            pid: null,
            port: 5173,
            url: null,
            error: "exited",
          },
        ],
      }),
    ).toBe("failed");
    expect(projectState(undefined)).toBe("stopped");
  });
  it("formats large runtime sizes without integer truncation", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5n * 1024n ** 3n)).toBe("5.0 GB");
  });
});
