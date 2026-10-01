import { describe, expect, it } from "vitest";
import {
  parseRulesetResponse,
  rulesetBody,
  rulesetDifferences,
  rulesetsEquivalent
} from "../src/normalize.js";
import { stableJson } from "../src/stable-json.js";
import { expectedRuleset } from "./helpers.js";

describe("ruleset normalization", () => {
  it("drops volatile metadata from GitHub responses", () => {
    const parsed = parseRulesetResponse({
      ...expectedRuleset(7),
      node_id: "RRS_1",
      created_at: "2026-01-01T00:00:00Z",
      _links: {},
      bypass_actors: [{ actor_id: 1, actor_type: "RepositoryRole", bypass_mode: "always", x: 1 }]
    });
    expect(Object.keys(parsed!).sort()).toEqual([
      "bypass_actors",
      "conditions",
      "enforcement",
      "id",
      "name",
      "rules",
      "target"
    ]);
    expect(parsed!.bypass_actors).toEqual([
      { actor_id: 1, actor_type: "RepositoryRole", bypass_mode: "always" }
    ]);
  });

  it("defaults absent conditions, rules and actors", () => {
    expect(
      parseRulesetResponse({
        id: 1,
        name: "n",
        target: "push",
        enforcement: "active",
        conditions: null
      })
    ).toEqual({
      id: 1,
      name: "n",
      target: "push",
      enforcement: "active",
      conditions: { ref_name: { include: [], exclude: [] } },
      rules: [],
      bypass_actors: []
    });
    expect(
      parseRulesetResponse({
        id: 1,
        name: "n",
        target: "branch",
        enforcement: "active",
        conditions: { repository_name: {} },
        bypass_actors: [{}]
      })?.bypass_actors
    ).toEqual([{ actor_id: null, actor_type: undefined, bypass_mode: undefined }]);
  });

  it.each([
    null,
    { id: 0, name: "n", target: "branch", enforcement: "active" },
    { id: 1, name: "", target: "branch", enforcement: "active" },
    { id: 1, name: "n", target: "org", enforcement: "active" },
    { id: 1, name: "n", target: "branch", enforcement: "active", conditions: [] },
    { id: 1, name: "n", target: "branch", enforcement: "active", conditions: { ref_name: [] } },
    {
      id: 1,
      name: "n",
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: [1], exclude: [] } }
    },
    { id: 1, name: "n", target: "branch", enforcement: "active", rules: {} },
    { id: 1, name: "n", target: "branch", enforcement: "active", rules: [{ type: 1 }] },
    {
      id: 1,
      name: "n",
      target: "branch",
      enforcement: "active",
      rules: [{ type: "x", parameters: [] }]
    },
    { id: 1, name: "n", target: "branch", enforcement: "active", bypass_actors: ["x"] }
  ])("rejects malformed ruleset %#", (value) => {
    expect(parseRulesetResponse(value)).toBeUndefined();
  });

  it("compares independent of ordering and defaulted parameters", () => {
    const desired = rulesetBody(expectedRuleset());
    const live = { ...expectedRuleset(99), rules: [...expectedRuleset().rules].reverse() };
    expect(rulesetsEquivalent(live, desired)).toBe(true);
    const twice = { ...desired, rules: [...desired.rules, { type: "deletion" }] };
    expect(rulesetDifferences(twice, desired)).toEqual(["rules.deletion#2:remove"]);
    expect(rulesetDifferences({ ...desired, name: "agentbench/x" }, desired)).toEqual(["target"]);
  });

  it("serializes keys deterministically and omits undefined values", () => {
    expect(stableJson({ b: 1, a: { d: undefined, c: [2, 1] }, B: 0 })).toBe(
      '{\n  "B": 0,\n  "a": {\n    "c": [\n      2,\n      1\n    ]\n  },\n  "b": 1\n}\n'
    );
  });
});
