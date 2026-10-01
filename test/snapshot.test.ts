import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSnapshot, readSnapshot, serializeSnapshot, writeSnapshot } from "../src/snapshot.js";
import { contract, expectedRuleset } from "./helpers.js";
import type { RecoverySnapshot } from "../src/types.js";

function snapshot(): RecoverySnapshot {
  return {
    schemaVersion: 1,
    repository: "octo/agentbench-protected-main-governance",
    defaultBranch: "main",
    managedNamePrefix: contract().managedNamePrefix,
    managedRulesets: [expectedRuleset()]
  };
}

async function tempPath(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "governance-snapshot-"));
  return { directory, path: join(directory, "snapshot.json") };
}

describe("recovery snapshots", () => {
  it("writes a private, credential-free snapshot and reads it back", async () => {
    const { directory, path } = await tempPath();
    await chmod(directory, 0o700);
    await writeSnapshot(path, snapshot());
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readSnapshot(path)).toEqual(snapshot());
  });

  it("creates missing parent directories", async () => {
    const { directory } = await tempPath();
    const path = join(directory, "nested", "snapshot.json");
    await writeSnapshot(path, snapshot());
    expect(await readSnapshot(path)).toEqual(snapshot());
  });

  it("does not overwrite an existing recovery snapshot", async () => {
    const { path } = await tempPath();
    await writeSnapshot(path, snapshot());
    await expect(writeSnapshot(path, snapshot())).rejects.toThrow(/already exists/);
  });

  it("reports unwritable locations without echoing the path", async () => {
    const { directory } = await tempPath();
    const blocker = join(directory, "file");
    await writeFile(blocker, "x");
    await expect(writeSnapshot(join(blocker, "snapshot.json"), snapshot())).rejects.toThrow();
    await chmod(directory, 0o500);
    try {
      const error = await writeSnapshot(join(directory, "s.json"), snapshot()).catch(
        (caught: unknown) => caught
      );
      expect(String(error)).toMatch(/unable to write the recovery snapshot/);
      expect(String(error)).not.toContain(directory);
    } finally {
      await chmod(directory, 0o700);
    }
  });

  it("reports a missing snapshot", async () => {
    const { path } = await tempPath();
    await expect(readSnapshot(path)).rejects.toMatchObject({ code: "SNAPSHOT_MISSING" });
  });

  it("rejects snapshots that are not JSON", async () => {
    const { path } = await tempPath();
    await writeFile(path, "{oops");
    await expect(readSnapshot(path)).rejects.toThrow(/invalid: not valid JSON/);
  });

  it("rejects structurally malformed snapshot JSON", async () => {
    const { path } = await tempPath();
    await writeFile(path, '{"schemaVersion":1,"managedRulesets":"not-an-array"}\n');
    await expect(readSnapshot(path)).rejects.toThrow(/invalid.*managedRulesets/i);
  });

  it("rejects unknown fields that could expand restore scope", async () => {
    const { path } = await tempPath();
    const value = { ...snapshot(), repositorySettings: { visibility: "private" } };
    await writeFile(path, JSON.stringify(value));
    await expect(readSnapshot(path)).rejects.toThrow(/unknown.*repositorySettings/i);
  });

  it.each([
    [[], /must be a JSON object/],
    [{ ...snapshot(), schemaVersion: 2 }, /schemaVersion must be 1/],
    [{ ...snapshot(), repository: "../../etc" }, /repository must be/],
    [{ ...snapshot(), defaultBranch: "" }, /defaultBranch/],
    [{ ...snapshot(), managedNamePrefix: "" }, /managedNamePrefix/],
    [
      { ...snapshot(), managedRulesets: [{ id: 1 }] },
      /managedRulesets\[0\] is not a valid ruleset/
    ],
    [
      { ...snapshot(), managedRulesets: [{ ...expectedRuleset(), name: "manual/freeze" }] },
      /outside the managed prefix/
    ],
    [
      { ...snapshot(), managedRulesets: [expectedRuleset(1), expectedRuleset(2)] },
      /duplicates managed ruleset name/
    ],
    [
      { ...snapshot(), managedRulesets: [{ ...expectedRuleset(), node_id: "x" }] },
      /unknown key "node_id" in managedRulesets\[0\]/
    ]
  ])("rejects malformed snapshot %#", (value, message) => {
    expect(() => parseSnapshot(value)).toThrow(message);
  });

  it("refuses to serialize credential-like material", () => {
    const secret = ["ghp", "abcdefghijklmnop"].join("_");
    const value = snapshot();
    value.managedRulesets[0]!.name = `agentbench/${secret}`;
    expect(() => serializeSnapshot(value)).toThrow(/credential-like/);
  });

  it("does not serialize local paths or credentials supplied outside the snapshot", async () => {
    const { directory, path } = await tempPath();
    await writeSnapshot(path, snapshot());
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain(directory);
    expect(raw).not.toMatch(/Authorization|Bearer|github_pat_|ghp_/i);
  });
});
