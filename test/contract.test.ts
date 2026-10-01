import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadContract, parseContract } from "../src/contract.js";
import { contract } from "./helpers.js";

function rawContract(): Record<string, unknown> {
  return structuredClone(contract()) as unknown as Record<string, unknown>;
}

function firstRuleset(value: Record<string, unknown>): Record<string, unknown> {
  return (value.rulesets as Array<Record<string, unknown>>)[0]!;
}

function firstRules(value: Record<string, unknown>): Record<string, unknown> {
  return firstRuleset(value).rules as Record<string, unknown>;
}

describe("contract validation", () => {
  it("accepts the tracked contract", () => {
    const parsed = parseContract(rawContract());
    expect(parsed.version).toBe(1);
    expect(parsed.rulesets[0]!.rules.requireStatusChecks).toEqual(["CI / test", "CI / package"]);
  });

  it("rejects unsupported versions", () => {
    const value = rawContract();
    value.version = 2;
    expect(() => parseContract(value)).toThrow(/unsupported contract version/);
  });

  it("rejects non-object contracts", () => {
    expect(() => parseContract([])).toThrow(/must be an object/);
  });

  it("rejects unknown top-level keys", () => {
    const value = rawContract();
    value.untrackedBehavior = true;
    expect(() => parseContract(value)).toThrow(/unknown.*untrackedBehavior/i);
  });

  it("rejects unknown ruleset keys", () => {
    const value = rawContract();
    firstRuleset(value).visibility = "private";
    expect(() => parseContract(value)).toThrow(/unknown key "visibility"/);
  });

  it("rejects unsupported rule types", () => {
    const value = rawContract();
    firstRules(value).requireSignedCommits = true;
    expect(() => parseContract(value)).toThrow(/unknown rule type "requireSignedCommits"/);
  });

  it("requires every rule to be stated explicitly", () => {
    const value = rawContract();
    delete firstRules(value).blockDeletions;
    expect(() => parseContract(value)).toThrow(/blockDeletions is required/);
  });

  it("rejects duplicate managed ruleset names", () => {
    const value = rawContract();
    const rulesets = value.rulesets as unknown[];
    const copy = structuredClone(rulesets[0]) as Record<string, unknown>;
    copy.branches = ["refs/heads/release/*"];
    rulesets.push(copy);
    expect(() => parseContract(value)).toThrow(/duplicate.*agentbench\/protected-main/i);
  });

  it("rejects empty status-check names", () => {
    const value = rawContract();
    firstRules(value).requireStatusChecks = ["CI / test", "   "];
    expect(() => parseContract(value)).toThrow(/status.*non-empty/i);
  });

  it.each([
    [["CI / test", "CI / test"], /duplicate status check/],
    [["CI / test", 4], /array of strings/],
    [" CI / test", /array of strings/],
    [[" CI / test"], /surrounding whitespace/]
  ])("rejects malformed status checks %j", (checks, message) => {
    const value = rawContract();
    firstRules(value).requireStatusChecks = checks;
    expect(() => parseContract(value)).toThrow(message);
  });

  it.each(["refs/heads/**", "refs/heads/*", "~ALL", "refs/heads/?ain"])(
    "rejects unsafe wildcard branch target %s",
    (branch) => {
      const value = rawContract();
      firstRuleset(value).branches = [branch];
      expect(() => parseContract(value)).toThrow(/unsafe.*wildcard/i);
    }
  );

  it.each([
    "main",
    "refs/tags/v1",
    "refs/heads/",
    "refs/heads/a..b",
    "refs/heads/feature.lock",
    "refs/heads/has space",
    "refs/heads/[ab]",
    "refs/heads/release/x**",
    ""
  ])("rejects malformed branch selector %j", (branch) => {
    const value = rawContract();
    firstRuleset(value).branches = [branch];
    expect(() => parseContract(value)).toThrow(/branch|non-empty|malformed|character/i);
  });

  it("accepts a scoped wildcard with a literal leading segment", () => {
    const value = rawContract();
    firstRuleset(value).branches = ["refs/heads/release/*", "refs/heads/release/**"];
    expect(parseContract(value).rulesets[0]!.branches).toHaveLength(2);
  });

  it("rejects empty and duplicate branch selector lists", () => {
    const value = rawContract();
    firstRuleset(value).branches = [];
    expect(() => parseContract(value)).toThrow(/non-empty array/);
    firstRuleset(value).branches = ["~DEFAULT_BRANCH", "~DEFAULT_BRANCH"];
    expect(() => parseContract(value)).toThrow(/duplicate selector/);
  });

  it("rejects unsupported merge methods", () => {
    const value = rawContract();
    value.mergeMethod = "force";
    expect(() => parseContract(value)).toThrow(/mergeMethod/i);
  });

  it("rejects rulesets outside the managed prefix", () => {
    const value = rawContract();
    firstRuleset(value).name = "manual/main";
    expect(() => parseContract(value)).toThrow(/outside the managed prefix/);
  });

  it.each(["", "agentbench", "*/", "a b/"])("rejects unsafe managed prefix %j", (prefix) => {
    const value = rawContract();
    value.managedNamePrefix = prefix;
    expect(() => parseContract(value)).toThrow(/managedNamePrefix/);
  });

  it("rejects a ruleset name equal to the prefix", () => {
    const value = rawContract();
    firstRuleset(value).name = "agentbench/";
    expect(() => parseContract(value)).toThrow(/extend the managed prefix/);
  });

  it("rejects invalid default branch names", () => {
    const value = rawContract();
    value.defaultBranch = "ma*in";
    expect(() => parseContract(value)).toThrow(/defaultBranch/);
  });

  it("rejects unsupported targets and enforcement levels", () => {
    const value = rawContract();
    firstRuleset(value).target = "tag";
    expect(() => parseContract(value)).toThrow(/target/);
    firstRuleset(value).target = "branch";
    firstRuleset(value).enforcement = "on";
    expect(() => parseContract(value)).toThrow(/enforcement/);
  });

  it.each([
    [{ requirePullRequest: false }, /conflicting policies.*requirePullRequest/],
    [{ strictStatusChecks: true, requireStatusChecks: [] }, /conflicting policies.*strict/],
    [{ requiredApprovals: 11 }, /requiredApprovals/],
    [{ requiredApprovals: 1.5 }, /requiredApprovals/],
    [{ blockForcePushes: "yes" }, /blockForcePushes must be a boolean/]
  ])("rejects invalid or conflicting rules %j", (patch, message) => {
    const value = rawContract();
    Object.assign(firstRules(value), patch);
    expect(() => parseContract(value)).toThrow(message);
  });

  it("rejects linear history combined with merge commits", () => {
    const value = rawContract();
    value.mergeMethod = "merge";
    expect(() => parseContract(value)).toThrow(/conflicting policies.*linear history/);
  });

  it("rejects two managed rulesets claiming the same branch", () => {
    const value = rawContract();
    const rulesets = value.rulesets as unknown[];
    const copy = structuredClone(rulesets[0]) as Record<string, unknown>;
    copy.name = "agentbench/other";
    rulesets.push(copy);
    expect(() => parseContract(value)).toThrow(/conflicting policies.*~DEFAULT_BRANCH/);
  });

  it("validates bypass actors strictly", () => {
    const value = rawContract();
    const actor = { actorId: 5, actorType: "RepositoryRole", bypassMode: "pull_request" };
    firstRuleset(value).bypassActors = [actor];
    expect(parseContract(value).rulesets[0]!.bypassActors).toEqual([actor]);
    firstRuleset(value).bypassActors = [actor, actor];
    expect(() => parseContract(value)).toThrow(/duplicate actor/);
    firstRuleset(value).bypassActors = [{ ...actor, actorId: -1 }];
    expect(() => parseContract(value)).toThrow(/actorId/);
    firstRuleset(value).bypassActors = [{ ...actor, actorType: "Everyone" }];
    expect(() => parseContract(value)).toThrow(/actorType/);
    firstRuleset(value).bypassActors = [{ ...actor, extra: 1 }];
    expect(() => parseContract(value)).toThrow(/unknown key "extra"/);
    firstRuleset(value).bypassActors = "none";
    expect(() => parseContract(value)).toThrow(/bypassActors must be an array/);
  });

  it("rejects malformed nesting", () => {
    const value = rawContract();
    value.rulesets = [];
    expect(() => parseContract(value)).toThrow(/non-empty array/);
    value.rulesets = ["x"];
    expect(() => parseContract(value)).toThrow(/rulesets\[0\] must be an object/);
    value.rulesets = [{ ...firstRuleset(rawContract()), rules: [] }];
    expect(() => parseContract(value)).toThrow(/rules must be an object/);
  });

  it("loads contracts from disk and reports unreadable or invalid JSON safely", async () => {
    const directory = await mkdtemp(join(tmpdir(), "governance-contract-"));
    const path = join(directory, "contract.json");
    await expect(loadContract(path)).rejects.toThrow(/could not be read/);
    await writeFile(path, "{not json");
    await expect(loadContract(path)).rejects.toThrow(/not valid JSON/);
    await writeFile(path, JSON.stringify(rawContract()));
    await expect(loadContract(path)).resolves.toMatchObject({ managedNamePrefix: "agentbench/" });
  });
});
