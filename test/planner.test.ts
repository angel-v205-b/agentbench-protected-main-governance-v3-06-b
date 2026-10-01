import { describe, expect, it } from "vitest";
import { buildPlan, isCompliant } from "../src/planner.js";
import { stableJson } from "../src/stable-json.js";
import type { GitHubRuleset } from "../src/types.js";
import { contract, expectedRuleset, legacyFixture, state } from "./helpers.js";

function liveShape(ruleset: GitHubRuleset): GitHubRuleset {
  // GitHub echoes defaulted parameters and orders arrays its own way.
  return {
    ...ruleset,
    rules: [...ruleset.rules].reverse().map((rule) =>
      rule.type === "required_status_checks"
        ? {
            ...rule,
            parameters: {
              ...(rule.parameters as object),
              required_status_checks: [{ context: "CI / package" }, { context: "CI / test" }]
            }
          }
        : rule.type === "pull_request"
          ? {
              ...rule,
              parameters: {
                ...(rule.parameters as object),
                required_reviewers: [],
                automatic_copilot_code_review_enabled: false,
                // Newer API defaults the contract does not state are outside the managed fields.
                require_extra_approval_for_unattributed_changes: true
              }
            }
          : rule
    )
  };
}

describe("governance planning", () => {
  it("reports no change when managed state matches", () => {
    const plan = buildPlan(contract(), state([expectedRuleset()]));
    expect(plan.actions).toEqual([]);
    expect(isCompliant(plan)).toBe(true);
  });

  it("ignores defaulted parameters and ordering differences in live responses", () => {
    const plan = buildPlan(contract(), state([liveShape(expectedRuleset())]));
    expect(plan.actions).toEqual([]);
  });

  it("is byte-deterministic for unchanged remote state", () => {
    const first = stableJson(buildPlan(contract(), state([])));
    const second = stableJson(buildPlan(contract(), state([])));
    expect(first).toBe(second);
    expect(first).not.toContain("generatedAt");
  });

  it("is independent of the order rulesets are listed in", () => {
    const rulesets = [...legacyFixture(), expectedRuleset(3)];
    const forward = stableJson(buildPlan(contract(), state(rulesets)));
    const reverse = stableJson(buildPlan(contract(), state([...rulesets].reverse())));
    expect(forward).toBe(reverse);
  });

  it("plans replacement before obsolete managed deletion", () => {
    const old = { ...expectedRuleset(18), name: "agentbench/legacy-main" };
    const plan = buildPlan(contract(), state([old]));
    expect(plan.actions.map((action) => `${action.kind}:${action.name}`)).toEqual([
      "create:agentbench/protected-main",
      "delete:agentbench/legacy-main"
    ]);
  });

  it("plans the minimum change for the legacy fixture", () => {
    const plan = buildPlan(contract(), state(legacyFixture()));
    expect(plan.actions).toMatchObject([
      { kind: "create", name: "agentbench/protected-main" },
      { kind: "delete", name: "agentbench/legacy-main", rulesetId: 7101, reason: "obsolete" }
    ]);
    expect(plan.preservedUnmanagedRulesets).toEqual(["manual/security-freeze"]);
  });

  it("updates drifted managed rulesets in place and names the drift", () => {
    const drifted: GitHubRuleset = {
      ...expectedRuleset(5),
      enforcement: "evaluate",
      bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
      rules: expectedRuleset(5).rules.filter((rule) => rule.type !== "required_linear_history")
    };
    const plan = buildPlan(contract(), state([drifted]));
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({
      kind: "update",
      rulesetId: 5,
      changes: ["enforcement", "bypass_actors", "rules.required_linear_history:add"]
    });
  });

  it("detects removed checks, extra rules and branch target drift", () => {
    const base = expectedRuleset(5);
    const drifted: GitHubRuleset = {
      ...base,
      conditions: { ref_name: { include: ["refs/heads/master"], exclude: [] } },
      rules: [
        ...base.rules.map((rule) =>
          rule.type === "required_status_checks"
            ? {
                ...rule,
                parameters: {
                  strict_required_status_checks_policy: true,
                  required_status_checks: [{ context: "CI / test" }]
                }
              }
            : rule
        ),
        { type: "creation" }
      ]
    };
    const plan = buildPlan(contract(), state([drifted]));
    expect(plan.actions[0]).toMatchObject({
      kind: "update",
      changes: [
        "conditions",
        "rules.creation:remove",
        "rules.required_status_checks:change(required_status_checks)"
      ]
    });
  });

  it("detects a stated parameter weakened to a non-default value", () => {
    const base = expectedRuleset(5);
    const weakened: GitHubRuleset = {
      ...base,
      rules: base.rules.map((rule) =>
        rule.type === "pull_request"
          ? {
              ...rule,
              parameters: {
                ...(rule.parameters as object),
                required_review_thread_resolution: false,
                dismiss_stale_reviews_on_push: true,
                allowed_merge_methods: ["merge", "squash"]
              }
            }
          : rule
      )
    };
    expect(buildPlan(contract(), state([weakened])).actions[0]).toMatchObject({
      kind: "update",
      changes: [
        "rules.pull_request:change(allowed_merge_methods,dismiss_stale_reviews_on_push,required_review_thread_resolution)"
      ]
    });
  });

  it("removes duplicate managed rulesets while keeping a compliant one", () => {
    const stale = { ...expectedRuleset(2), enforcement: "disabled" as const };
    const plan = buildPlan(contract(), state([stale, expectedRuleset(9), expectedRuleset(11)]));
    expect(plan.actions).toEqual([
      { kind: "delete", name: "agentbench/protected-main", rulesetId: 2, reason: "duplicate" },
      { kind: "delete", name: "agentbench/protected-main", rulesetId: 11, reason: "duplicate" }
    ]);
  });

  it("updates the oldest duplicate when none is compliant", () => {
    const first = { ...expectedRuleset(4), enforcement: "disabled" as const };
    const second = { ...expectedRuleset(8), enforcement: "evaluate" as const };
    const plan = buildPlan(contract(), state([second, first]));
    expect(
      plan.actions.map((action) => [action.kind, "rulesetId" in action && action.rulesetId])
    ).toEqual([
      ["update", 4],
      ["delete", 8]
    ]);
  });

  it("preserves and reports unmanaged rulesets", () => {
    const unmanaged = { ...expectedRuleset(91), name: "manual/security-freeze" };
    const plan = buildPlan(contract(), state([unmanaged]));
    expect(plan.preservedUnmanagedRulesets).toEqual(["manual/security-freeze"]);
    expect(plan.actions.every((action) => action.name !== unmanaged.name)).toBe(true);
  });

  it("uses the actual default branch rather than assuming main", () => {
    const remoteState = { ...state([]), defaultBranch: "trunk" };
    const plan = buildPlan(contract(), remoteState);
    const create = plan.actions.find((action) => action.kind === "create");
    expect(create?.desired.conditions.ref_name.include).toEqual(["refs/heads/trunk"]);
    expect(plan.warnings[0]).toMatch(/expects default branch "main".*"trunk"/);
  });

  it("blocks when a required check is not produced by any workflow", () => {
    const plan = buildPlan(contract(), {
      ...state([expectedRuleset()]),
      workflowChecks: ["CI / test"]
    });
    expect(plan.blockers).toEqual([
      'required status check "CI / package" is not produced by any workflow job on the default branch'
    ]);
    expect(isCompliant(plan)).toBe(false);
  });

  it("warns about classic branch protection it does not manage", () => {
    const plan = buildPlan(contract(), { ...state([]), defaultBranchClassicProtection: true });
    expect(plan.warnings).toEqual([expect.stringMatching(/classic branch protection/)]);
  });

  it("requires the squash merge method, pull requests and both CI checks", () => {
    const plan = buildPlan(contract(), state([]));
    const create = plan.actions[0];
    expect(create?.kind).toBe("create");
    const rules = create?.kind === "create" ? create.desired.rules : [];
    expect(rules.map((rule) => rule.type)).toEqual([
      "deletion",
      "non_fast_forward",
      "required_linear_history",
      "pull_request",
      "required_status_checks"
    ]);
    expect(rules[3]?.parameters).toMatchObject({
      allowed_merge_methods: ["squash"],
      required_review_thread_resolution: true
    });
    expect(rules[4]?.parameters).toMatchObject({
      strict_required_status_checks_policy: true,
      required_status_checks: [{ context: "CI / test" }, { context: "CI / package" }]
    });
    expect(create?.kind === "create" && create.desired.bypass_actors).toEqual([]);
  });
});
