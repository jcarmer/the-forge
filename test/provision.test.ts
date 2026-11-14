import { describe, it, expect } from "vitest";
import { runProvision, type ProvisionStep } from "../src/provision/steps.js";

describe("idempotent provisioner", () => {
  it("skips apply when check() is already true", () => {
    let applied = 0;
    const steps: ProvisionStep[] = [{ name: "a", check: () => true, apply: () => { applied++; } }];
    expect(runProvision(steps)).toEqual([{ name: "a", status: "already-ok" }]);
    expect(applied).toBe(0);
  });

  it("calls apply() when check() is false, and is idempotent on second run", () => {
    let state = false;
    let calls = 0;
    const steps: ProvisionStep[] = [{ name: "b", check: () => state, apply: () => { state = true; calls++; } }];
    expect(runProvision(steps)[0].status).toBe("applied");
    expect(runProvision(steps)[0].status).toBe("already-ok");
    expect(calls).toBe(1);
  });

  it("captures failures without aborting remaining steps", () => {
    const steps: ProvisionStep[] = [
      { name: "bad", check: () => false, apply: () => { throw new Error("boom"); } },
      { name: "good", check: () => true, apply: () => {} },
    ];
    const res = runProvision(steps);
    expect(res[0]).toMatchObject({ name: "bad", status: "failed" });
    expect(res[1]).toEqual({ name: "good", status: "already-ok" });
  });
});
