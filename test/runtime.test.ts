import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apply, CountingTransport, plan, restore, verify } from "../src/runtime.js";
import type { GitHubTransport } from "../src/types.js";
import { expectedRuleset, FakeGitHub, legacyFixture, tempRepository } from "./helpers.js";

async function setup(initial = legacyFixture()) {
  const cwd = await tempRepository("https://github.com/octo/repository.git");
  const github = new FakeGitHub("octo", "repository", initial);
  return { cwd, github, options: { cwd, transport: github as GitHubTransport } };
}

describe("runtime commands", () => {
  it("plan is read-only and byte-identical across runs", async () => {
    const { cwd, github, options } = await setup();
    const first = await plan(options);
    const json = await readFile(join(cwd, "artifacts/governance-plan.json"), "utf8");
    const markdown = await readFile(join(cwd, "artifacts/governance-plan.md"), "utf8");
    const second = await plan(options);
    expect(await readFile(join(cwd, "artifacts/governance-plan.json"), "utf8")).toBe(json);
    expect(await readFile(join(cwd, "artifacts/governance-plan.md"), "utf8")).toBe(markdown);
    expect(github.writes).toEqual([]);
    expect(first.remoteWrites + second.remoteWrites).toBe(0);
    expect(first.plan.actions.map((action) => action.kind)).toEqual(["create", "delete"]);
    expect(json).not.toContain(cwd);
    expect(json).not.toMatch(/Bearer|token|created_at|node_id/i);
  });

  it("apply rolls out the contract, verifies it, and a second apply writes nothing", async () => {
    const { cwd, github, options } = await setup();
    const unmanagedBefore = structuredClone(github.rulesets.get(9101));
    const first = await apply(options);
    expect(first.changes).toEqual({
      created: ["agentbench/protected-main"],
      updated: [],
      deleted: ["agentbench/legacy-main"]
    });
    expect(first.remoteWrites).toBe(2);
    expect(github.writes.map((call) => call.method)).toEqual(["POST", "DELETE"]);
    expect(github.rulesets.get(9101)).toEqual(unmanagedBefore);

    const snapshot = await readFile(join(cwd, "artifacts/recovery-snapshot.json"), "utf8");
    expect(JSON.parse(snapshot)).toMatchObject({
      repository: "octo/repository",
      managedRulesets: [{ id: 7101, name: "agentbench/legacy-main" }]
    });
    expect(snapshot).not.toContain("security-freeze");
    expect(snapshot).not.toContain(cwd);

    const second = await apply(options);
    expect(second.remoteWrites).toBe(0);
    expect(second.plan.actions).toEqual([]);
    expect(github.writes).toHaveLength(2);
    await expect(verify(options)).resolves.toMatchObject({ remoteWrites: 0 });
    const replan = await plan(options);
    expect(replan.plan.actions).toEqual([]);
  });

  it("apply refuses to run when required checks are not configured", async () => {
    const { github, options } = await setup([]);
    github.workflows = {};
    await expect(apply(options)).rejects.toThrow(/blockers/);
    expect(github.writes).toEqual([]);
  });

  it("apply reports drift that persists after writing", async () => {
    const { github, options } = await setup([]);
    let creates = 0;
    // GitHub accepts the create but a concurrent actor immediately adds a duplicate.
    const racing: GitHubTransport = {
      request: async (method, path, body) => {
        const response = await github.request(method, path, body);
        if (method === "GET" && /rulesets\/\d+$/.test(path) && creates++ === 0) {
          await github.request(
            "POST",
            "/repos/octo/repository/rulesets",
            body ?? expectedRuleset(0)
          );
        }
        return response as never;
      }
    };
    await expect(apply({ ...options, transport: racing })).rejects.toThrow(/still differs/);
  });

  it("verify reports drift without writing", async () => {
    const { github, options } = await setup();
    await expect(verify(options)).rejects.toMatchObject({ code: "POLICY_DRIFT" });
    await expect(verify(options)).rejects.toThrow(
      /create agentbench\/protected-main; delete agentbench\/legacy-main/
    );
    expect(github.writes).toEqual([]);
  });

  it("restore validates the snapshot before contacting GitHub", async () => {
    const { cwd, github, options } = await setup();
    await expect(restore(options)).rejects.toMatchObject({ code: "SNAPSHOT_MISSING" });
    await mkdir(join(cwd, "artifacts"), { recursive: true });
    await writeFile(join(cwd, "artifacts/recovery-snapshot.json"), '{"schemaVersion":1}');
    await expect(restore(options)).rejects.toMatchObject({ code: "SNAPSHOT_INVALID" });
    expect(github.calls).toEqual([]);
  });

  it("restore returns managed rulesets to the snapshot and preserves unmanaged ones", async () => {
    const { cwd, github, options } = await setup();
    await apply(options);
    const unmanagedBefore = structuredClone(github.rulesets.get(9101));
    const result = await restore(options);
    expect(result.changes).toEqual({
      created: ["agentbench/legacy-main"],
      updated: [],
      deleted: ["agentbench/protected-main"]
    });
    expect(github.names()).toEqual(["agentbench/legacy-main", "manual/security-freeze"]);
    expect(github.rulesets.get(9101)).toEqual(unmanagedBefore);

    // A later rollout needs the operator to archive the consumed snapshot first.
    await expect(apply(options)).rejects.toMatchObject({ code: "SNAPSHOT_EXISTS" });
    await rm(join(cwd, "artifacts/recovery-snapshot.json"));
    await expect(apply(options)).resolves.toMatchObject({ remoteWrites: 2 });
  });

  it("rejects credential-bearing origin remotes before reading any token", async () => {
    const cwd = await tempRepository(
      ["https://", "user:pw@", "github.com/octo/repository.git"].join("")
    );
    const github = new FakeGitHub();
    await expect(plan({ cwd, transport: github })).rejects.toThrow(/credential-free/);
    expect(github.calls).toEqual([]);
  });

  it("counts reads and writes", async () => {
    const github = new FakeGitHub("octo", "repository", [expectedRuleset(1)]);
    const counter = new CountingTransport(github);
    await counter.request("GET", "/repos/octo/repository/rulesets/1");
    await counter.request("DELETE", "/repos/octo/repository/rulesets/1");
    expect([counter.reads, counter.writes]).toEqual([1, 1]);
  });
});
