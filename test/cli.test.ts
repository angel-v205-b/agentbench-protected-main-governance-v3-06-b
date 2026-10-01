import { describe, expect, it, vi } from "vitest";
import { EXIT_DRIFT, EXIT_FAILURE, EXIT_OK, EXIT_USAGE, main, type Runtime } from "../src/cli.js";
import { PolicyError } from "../src/errors.js";
import { buildPlan } from "../src/planner.js";
import { contract, expectedRuleset, state } from "./helpers.js";

const noChanges = { created: [], updated: [], deleted: [] };

function runtime(overrides: Partial<Runtime> = {}): Runtime {
  const plan = buildPlan(contract(), state([expectedRuleset()]));
  return {
    plan: vi.fn(async () => ({ plan, remoteWrites: 0 })),
    apply: vi.fn(async () => ({ plan, remoteWrites: 0, changes: noChanges })),
    verify: vi.fn(async () => ({ plan, remoteWrites: 0 })),
    restore: vi.fn(async () => ({ remoteWrites: 1, changes: { ...noChanges, created: ["x"] } })),
    ...overrides
  };
}

function output() {
  return { log: vi.fn(), error: vi.fn() };
}

describe("CLI", () => {
  it("returns usage status for an unknown command", async () => {
    const out = output();
    await expect(main(["destroy"], out, runtime())).resolves.toBe(EXIT_USAGE);
    expect(out.error).toHaveBeenCalledWith("usage: repository-policy <plan|apply|verify|restore>");
  });

  it("returns usage status when extra positional arguments are supplied", async () => {
    const commands = runtime();
    await expect(main(["plan", "extra"], output(), commands)).resolves.toBe(EXIT_USAGE);
    await expect(main([], output(), commands)).resolves.toBe(EXIT_USAGE);
    expect(commands.plan).not.toHaveBeenCalled();
  });

  it.each(["plan", "apply", "verify", "restore"] as const)(
    "exits 0 when %s succeeds",
    async (command) => {
      const commands = runtime();
      const out = output();
      await expect(main([command], out, commands)).resolves.toBe(EXIT_OK);
      expect(commands[command]).toHaveBeenCalledOnce();
      expect(out.log).toHaveBeenCalled();
    }
  );

  it("reports planned changes, blockers and warnings", async () => {
    const plan = { ...buildPlan(contract(), state([])), blockers: ["b1"], warnings: ["w1"] };
    const out = output();
    await main(["plan"], out, runtime({ plan: async () => ({ plan, remoteWrites: 0 }) }));
    expect(out.log).toHaveBeenCalledWith(
      expect.stringMatching(/^1 managed change\(s\) planned for octo-tester\//)
    );
    expect(out.error).toHaveBeenCalledWith("blocker: b1");
    expect(out.log).toHaveBeenCalledWith("warning: w1");
  });

  it("reports applied changes and remote write counts", async () => {
    const plan = buildPlan(contract(), state([]));
    const out = output();
    await main(
      ["apply"],
      out,
      runtime({
        apply: async () => ({ plan, remoteWrites: 2, changes: { ...noChanges, created: ["a"] } })
      })
    );
    expect(out.log).toHaveBeenCalledWith(
      "managed policy applied and verified (created 1, updated 0, deleted 0)"
    );
    expect(out.log).toHaveBeenCalledWith("remote write requests: 2");
  });

  it("exits 3 for policy drift and 1 for other failures", async () => {
    const drift = runtime({
      verify: async () => {
        throw new PolicyError("live policy differs", "POLICY_DRIFT");
      }
    });
    await expect(main(["verify"], output(), drift)).resolves.toBe(EXIT_DRIFT);
    const broken = runtime({
      apply: async () => {
        throw new Error("boom");
      }
    });
    await expect(main(["apply"], output(), broken)).resolves.toBe(EXIT_FAILURE);
  });

  it("redacts credential material from error output", async () => {
    const secret = ["ghp", "abcdefghijklmnopqrstu"].join("_");
    const out = output();
    const leaky = runtime({
      restore: async () => {
        throw new Error(`request failed with Authorization: Bearer ${secret}`);
      }
    });
    await expect(main(["restore"], out, leaky)).resolves.toBe(EXIT_FAILURE);
    expect(out.error).toHaveBeenCalledWith("request failed with Authorization: Bearer [REDACTED]");
  });
});
