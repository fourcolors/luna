import { describe, expect, it } from "vitest";
import { makeTaskDef, taskDefFromDelegation } from "./task-defs.js";

describe("Studio task definitions", () => {
  it("normalizes delegated requests into the requested runner shape", () => {
    const def = taskDefFromDelegation("openclaw", "Please find rooftop bars tonight.");
    expect(def.variant).toBe("computer");
    expect(def.brain).toBe("openclaw");
    expect(def.title).toBe("Please find rooftop bars tonight");
    expect(def.steps.length).toBeGreaterThan(3);
  });

  it("keeps research and development timing self-contained", () => {
    expect(makeTaskDef("research", "compare providers", "hermes")).toMatchObject({
      variant: "dev",
      brain: "hermes",
      dur: 28,
    });
    expect(makeTaskDef("dev", "build the landing page", "hermes")).toMatchObject({
      variant: "dev",
      brain: "hermes",
      dur: 38,
    });
  });
});
