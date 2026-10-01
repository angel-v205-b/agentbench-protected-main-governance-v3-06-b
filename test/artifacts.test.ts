import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planMarkdown, writePlanArtifacts } from "../src/artifacts.js";
import { buildPlan } from "../src/planner.js";
import { contract, expectedRuleset, legacyFixture, state } from "./helpers.js";

async function paths() {
  const directory = await mkdtemp(join(tmpdir(), "governance-plan-"));
  return { directory, json: join(directory, "plan.json"), markdown: join(directory, "plan.md") };
}

describe("plan artifacts", () => {
  it("writes byte-identical output for identical inputs", async () => {
    const { json, markdown } = await paths();
    await writePlanArtifacts(buildPlan(contract(), state([])), json, markdown);
    const first = [await readFile(json, "utf8"), await readFile(markdown, "utf8")];
    await writePlanArtifacts(buildPlan(contract(), state([])), json, markdown);
    const second = [await readFile(json, "utf8"), await readFile(markdown, "utf8")];
    expect(second).toEqual(first);
  });

  it("contains no absolute local path", async () => {
    const { directory, json, markdown } = await paths();
    await writePlanArtifacts(buildPlan(contract(), state([])), json, markdown);
    expect(await readFile(json, "utf8")).not.toContain(directory);
    expect(await readFile(markdown, "utf8")).not.toContain(directory);
  });

  it("summarizes every kind of change, blocker and warning", () => {
    const drifted = { ...expectedRuleset(4), enforcement: "evaluate" as const };
    const plan = buildPlan(contract(), {
      ...state([...legacyFixture(), drifted]),
      workflowChecks: [],
      defaultBranchClassicProtection: true
    });
    const markdown = planMarkdown(plan);
    expect(markdown).toContain("- update `agentbench/protected-main` (ruleset 4): enforcement");
    expect(markdown).toContain(
      "- delete obsolete `agentbench/legacy-main` (ruleset 7101) after replacements are verified"
    );
    expect(markdown).toContain('required status check "CI / test" is not produced');
    expect(markdown).toContain("Classic branch protection on default branch: yes");
    expect(markdown).toContain("- `manual/security-freeze`");
    expect(markdown).toContain("None found.");
  });

  it("renders the no-change case", () => {
    const markdown = planMarkdown(buildPlan(contract(), state([expectedRuleset()])));
    expect(markdown).toContain("No changes required.");
    expect(markdown).toContain("## Blockers\n\nNone.");
    expect(markdown).toContain("None observed.");
    expect(planMarkdown(buildPlan(contract(), state([])))).toContain(
      "- create `agentbench/protected-main` targeting `refs/heads/main`"
    );
  });

  it("refuses to write credential-like material", async () => {
    const { json, markdown } = await paths();
    const plan = buildPlan(contract(), state([]));
    plan.preservedUnmanagedRulesets = [["ghp", "abcdefghijklmnopqrst"].join("_")];
    await expect(writePlanArtifacts(plan, json, markdown)).rejects.toThrow(/credential-like/);
  });
});
