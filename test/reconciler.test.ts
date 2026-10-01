import { describe, expect, it } from "vitest";
import { GitHubClient } from "../src/github.js";
import { buildPlan } from "../src/planner.js";
import { applyPlan, restoreSnapshot, type SnapshotStore } from "../src/reconciler.js";
import type { GitHubRuleset, RecoverySnapshot } from "../src/types.js";
import {
  contract,
  expectedRuleset,
  FakeGitHub,
  legacyFixture,
  planOf,
  RecordingTransport,
  state
} from "./helpers.js";

function store(
  events: string[] = []
): SnapshotStore & { saved: RecoverySnapshot[]; events: string[] } {
  const saved: RecoverySnapshot[] = [];
  return {
    saved,
    events,
    save: async (snapshot) => {
      events.push("snapshot");
      saved.push(snapshot);
    },
    load: async () => {
      throw new Error("not used");
    }
  };
}

async function liveRulesets(github: FakeGitHub): Promise<GitHubRuleset[]> {
  const client = new GitHubClient(github.owner, github.repository, github);
  const summaries = await client.listRulesets();
  return Promise.all(summaries.map((summary) => client.getRuleset(summary.id)));
}

function stateFor(github: FakeGitHub, rulesets: GitHubRuleset[]) {
  return { ...state(rulesets), owner: github.owner, repository: github.repository };
}

describe("managed policy reconciliation", () => {
  it("captures managed pre-change state before the first remote write", async () => {
    const events: string[] = [];
    const transport = new RecordingTransport();
    transport.queue(expectedRuleset(73), 201);
    transport.queue(expectedRuleset(73), 200);
    const wrapped = {
      request: <T>(method: string, path: string, body?: unknown) => {
        events.push(method);
        return transport.request<T>(method, path, body);
      }
    };
    const client = new GitHubClient("octo", "repository", wrapped);
    const snapshots = store(events);
    const plan = planOf([
      { kind: "create", name: "agentbench/protected-main", desired: expectedRuleset(0) }
    ]);
    const result = await applyPlan(client, contract(), plan, [], snapshots);
    expect(snapshots.saved).toHaveLength(1);
    expect(events).toEqual(["snapshot", "POST", "GET"]);
    expect(result.created).toEqual(["agentbench/protected-main"]);
  });

  it("creates and verifies a replacement before deleting obsolete policy", async () => {
    const transport = new RecordingTransport();
    transport.queue(expectedRuleset(88), 201);
    transport.queue(expectedRuleset(88), 200);
    transport.queue(null, 204);
    const client = new GitHubClient("octo", "repository", transport);
    const old = { ...expectedRuleset(18), name: "agentbench/legacy-main" };
    const plan = planOf([
      { kind: "delete", name: old.name, rulesetId: old.id, reason: "obsolete" },
      { kind: "create", name: "agentbench/protected-main", desired: expectedRuleset(0) }
    ]);
    await applyPlan(client, contract(), plan, [old], store());
    expect(transport.calls.map((call) => call.method)).toEqual(["POST", "GET", "DELETE"]);
    expect(transport.calls[1]!.path).toBe("/repos/octo/repository/rulesets/88");
  });

  it("performs no snapshot or remote write for an empty plan", async () => {
    const transport = new RecordingTransport();
    const client = new GitHubClient("octo", "repository", transport);
    const snapshots = store();
    await applyPlan(client, contract(), planOf([]), [expectedRuleset()], snapshots);
    expect(transport.calls).toEqual([]);
    expect(snapshots.saved).toEqual([]);
  });

  it("is idempotent: a second apply sends no writes and creates no duplicates", async () => {
    const github = new FakeGitHub("octo", "repository", legacyFixture());
    const client = new GitHubClient("octo", "repository", github);
    const first = await liveRulesets(github);
    await applyPlan(
      client,
      contract(),
      buildPlan(contract(), stateFor(github, first)),
      first,
      store()
    );
    expect(github.names()).toEqual(["agentbench/protected-main", "manual/security-freeze"]);

    const writesBefore = github.writes.length;
    const second = await liveRulesets(github);
    const plan = buildPlan(contract(), stateFor(github, second));
    expect(plan.actions).toEqual([]);
    await applyPlan(client, contract(), plan, second, store());
    expect(github.writes.length).toBe(writesBefore);
    expect(github.names()).toEqual(["agentbench/protected-main", "manual/security-freeze"]);
  });

  it("leaves unmanaged rulesets untouched", async () => {
    const github = new FakeGitHub("octo", "repository", legacyFixture());
    const unmanagedBefore = structuredClone(github.rulesets.get(9101));
    const client = new GitHubClient("octo", "repository", github);
    const before = await liveRulesets(github);
    await applyPlan(
      client,
      contract(),
      buildPlan(contract(), stateFor(github, before)),
      before,
      store()
    );
    expect(github.rulesets.get(9101)).toEqual(unmanagedBefore);
    expect(github.writes.some((call) => call.path.endsWith("/9101"))).toBe(false);
  });

  it("rolls back and keeps the obsolete policy when replacement verification fails", async () => {
    const github = new FakeGitHub("octo", "repository", legacyFixture());
    github.storeHook = (body) => ({ ...body, enforcement: "evaluate" });
    const client = new GitHubClient("octo", "repository", github);
    const before = await liveRulesets(github);
    const plan = buildPlan(contract(), stateFor(github, before));
    await expect(applyPlan(client, contract(), plan, before, store())).rejects.toThrow(
      /stopped before deleting.*failed independent verification \(enforcement\).*returned to the recorded pre-change state/
    );
    expect(github.names()).toEqual(["agentbench/legacy-main", "manual/security-freeze"]);
    expect(github.writes.map((call) => call.method)).toEqual(["POST", "DELETE"]);
  });

  it("restores the previous body when an in-place update fails verification", async () => {
    const drifted = { ...expectedRuleset(31), enforcement: "evaluate" as const };
    const github = new FakeGitHub("octo", "repository", [drifted]);
    let calls = 0;
    github.storeHook = (body) => (calls++ === 0 ? { ...body, enforcement: "disabled" } : body);
    const client = new GitHubClient("octo", "repository", github);
    const before = await liveRulesets(github);
    await expect(
      applyPlan(
        client,
        contract(),
        buildPlan(contract(), stateFor(github, before)),
        before,
        store()
      )
    ).rejects.toThrow(/APPLY_FAILED|stopped before deleting/);
    expect(github.rulesets.get(31)?.enforcement).toBe("evaluate");
  });

  it("does not delete anything when the replacement create fails", async () => {
    const github = new FakeGitHub("octo", "repository", legacyFixture());
    github.failNext("POST", /rulesets$/, 422);
    const client = new GitHubClient("octo", "repository", github);
    const before = await liveRulesets(github);
    await expect(
      applyPlan(
        client,
        contract(),
        buildPlan(contract(), stateFor(github, before)),
        before,
        store()
      )
    ).rejects.toThrow(/stopped before deleting any obsolete managed ruleset/);
    expect(github.names()).toEqual(["agentbench/legacy-main", "manual/security-freeze"]);
    expect(github.writes.map((call) => call.method)).toEqual(["POST"]);
  });

  it("reports an incomplete rollback so the operator can restore", async () => {
    const github = new FakeGitHub("octo", "repository", legacyFixture());
    github.storeHook = (body) => ({ ...body, enforcement: "evaluate" });
    github.failNext("DELETE", /rulesets\/\d+$/, 503, 5);
    const client = new GitHubClient("octo", "repository", github);
    const before = await liveRulesets(github);
    await expect(
      applyPlan(
        client,
        contract(),
        buildPlan(contract(), stateFor(github, before)),
        before,
        store()
      )
    ).rejects.toThrow(/rollback was incomplete.*run restore/);
  });

  it("keeps the verified replacement when deleting obsolete policy fails, and a rerun finishes", async () => {
    const github = new FakeGitHub("octo", "repository", legacyFixture());
    github.failNext("DELETE", /rulesets\/7101$/, 500);
    const client = new GitHubClient("octo", "repository", github);
    const before = await liveRulesets(github);
    await expect(
      applyPlan(
        client,
        contract(),
        buildPlan(contract(), stateFor(github, before)),
        before,
        store()
      )
    ).rejects.toThrow(/verified replacement policy is active.*re-run apply/);
    expect(github.names()).toEqual([
      "agentbench/legacy-main",
      "agentbench/protected-main",
      "manual/security-freeze"
    ]);

    const again = await liveRulesets(github);
    const plan = buildPlan(contract(), stateFor(github, again));
    expect(plan.actions.map((action) => action.kind)).toEqual(["delete"]);
    await applyPlan(client, contract(), plan, again, store());
    expect(github.names()).toEqual(["agentbench/protected-main", "manual/security-freeze"]);
  });

  it("refuses blocked, stale or out-of-scope plans before writing", async () => {
    const transport = new RecordingTransport();
    const client = new GitHubClient("octo", "repository", transport);
    const snapshots = store();
    await expect(
      applyPlan(client, contract(), planOf([], ["missing check"]), [], snapshots)
    ).rejects.toThrow(/blockers/);
    await expect(
      applyPlan(
        client,
        contract(),
        planOf([{ kind: "delete", name: "agentbench/gone", rulesetId: 9, reason: "obsolete" }]),
        [],
        snapshots
      )
    ).rejects.toThrow(/not observed/);
    await expect(
      applyPlan(
        client,
        contract(),
        planOf([{ kind: "delete", name: "manual/x", rulesetId: 9, reason: "obsolete" }]),
        [],
        snapshots
      )
    ).rejects.toThrow(/unmanaged/);
    expect(transport.calls).toEqual([]);
    expect(snapshots.saved).toEqual([]);
  });
});

function snapshotOf(rulesets: GitHubRuleset[], repository = "octo/repository"): RecoverySnapshot {
  return {
    schemaVersion: 1,
    repository,
    defaultBranch: "main",
    managedNamePrefix: "agentbench/",
    managedRulesets: rulesets
  };
}

describe("restore", () => {
  it("preserves unmanaged rulesets", async () => {
    const transport = new RecordingTransport();
    const client = new GitHubClient("octo", "repository", transport);
    const managed = expectedRuleset(12);
    const unmanaged = { ...expectedRuleset(90), name: "manual/security-freeze" };
    await restoreSnapshot(client, contract(), snapshotOf([expectedRuleset(44)]), [
      managed,
      unmanaged
    ]);
    expect(transport.calls.some((call) => call.path.endsWith("/90"))).toBe(false);
  });

  it("restores the recorded managed state after a rollout", async () => {
    const legacy = legacyFixture();
    const github = new FakeGitHub("octo", "repository", legacy);
    const client = new GitHubClient("octo", "repository", github);
    const before = await liveRulesets(github);
    const snapshots = store();
    await applyPlan(
      client,
      contract(),
      buildPlan(contract(), stateFor(github, before)),
      before,
      snapshots
    );
    const unmanagedBefore = structuredClone(github.rulesets.get(9101));

    const current = await liveRulesets(github);
    const result = await restoreSnapshot(client, contract(), snapshots.saved[0]!, current);
    expect(result).toEqual({
      created: ["agentbench/legacy-main"],
      updated: [],
      deleted: ["agentbench/protected-main"]
    });
    expect(github.names()).toEqual(["agentbench/legacy-main", "manual/security-freeze"]);
    expect(github.rulesets.get(9101)).toEqual(unmanagedBefore);
    const restored = (await liveRulesets(github)).find((r) => r.name === "agentbench/legacy-main");
    expect(restored?.rules).toEqual([{ type: "non_fast_forward" }]);
  });

  it("updates drifted recorded rulesets in place and skips unchanged ones", async () => {
    const recorded = [expectedRuleset(5), { ...expectedRuleset(6), name: "agentbench/other" }];
    const github = new FakeGitHub("octo", "repository", [
      { ...expectedRuleset(5), enforcement: "disabled" },
      { ...expectedRuleset(6), name: "agentbench/other" }
    ]);
    const client = new GitHubClient("octo", "repository", github);
    const result = await restoreSnapshot(
      client,
      contract(),
      snapshotOf(recorded),
      await liveRulesets(github)
    );
    expect(result).toEqual({ created: [], updated: ["agentbench/protected-main"], deleted: [] });
    expect(github.writes.map((call) => `${call.method} ${call.path}`)).toEqual([
      "PUT /repos/octo/repository/rulesets/5"
    ]);
  });

  it("deletes nothing and reports progress when a restore write fails partway", async () => {
    const recorded = [
      { ...expectedRuleset(1), name: "agentbench/a" },
      { ...expectedRuleset(2), name: "agentbench/b" }
    ];
    const github = new FakeGitHub("octo", "repository", [expectedRuleset(50)]);
    let posts = 0;
    const secondPostFails = {
      request: <T>(method: string, path: string, body?: unknown) => {
        if (method === "POST" && ++posts === 2) {
          return Promise.reject(new Error("GitHub POST failed (502)"));
        }
        return github.request<T>(method, path, body);
      }
    };
    const client = new GitHubClient("octo", "repository", secondPostFails);
    await expect(
      restoreSnapshot(client, contract(), snapshotOf(recorded), await liveRulesets(github))
    ).rejects.toThrow(
      /restore of agentbench\/b failed.*no managed ruleset was deleted; restored so far: created \[agentbench\/a\]/
    );
    expect(github.names()).toEqual(["agentbench/a", "agentbench/protected-main"]);
    expect(github.writes.every((call) => call.method !== "DELETE")).toBe(true);
  });

  it("reports a failed deletion after restore writes succeed", async () => {
    const github = new FakeGitHub("octo", "repository", [expectedRuleset(50)]);
    github.failNext("DELETE", /rulesets\/50$/, 500);
    const client = new GitHubClient("octo", "repository", github);
    await expect(
      restoreSnapshot(
        client,
        contract(),
        snapshotOf(legacyFixture().slice(0, 1)),
        await liveRulesets(github)
      )
    ).rejects.toThrow(/restored, but deleting agentbench\/protected-main failed/);
    expect(github.names()).toEqual(["agentbench/legacy-main", "agentbench/protected-main"]);
  });

  it("rejects a snapshot captured for a different repository", async () => {
    const client = new GitHubClient("octo", "repository", new RecordingTransport());
    await expect(
      restoreSnapshot(client, contract(), snapshotOf([], "someone/else"), [])
    ).rejects.toThrow(/repository.*mismatch/i);
  });

  it("rejects snapshots for another prefix or with out-of-scope rulesets", async () => {
    const transport = new RecordingTransport();
    const client = new GitHubClient("octo", "repository", transport);
    await expect(
      restoreSnapshot(client, contract(), { ...snapshotOf([]), managedNamePrefix: "other/" }, [])
    ).rejects.toThrow(/prefix does not match/);
    await expect(
      restoreSnapshot(
        client,
        contract(),
        snapshotOf([{ ...expectedRuleset(3), name: "manual/x" }]),
        []
      )
    ).rejects.toThrow(/outside the managed prefix/);
    expect(transport.calls).toEqual([]);
  });
});
