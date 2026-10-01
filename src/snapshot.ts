import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PolicyError } from "./errors.js";
import { parseRulesetResponse } from "./normalize.js";
import { redactSensitive } from "./redaction.js";
import { stableJson } from "./stable-json.js";
import type { GitHubRuleset, RecoverySnapshot } from "./types.js";

const SNAPSHOT_KEYS = [
  "schemaVersion",
  "repository",
  "defaultBranch",
  "managedNamePrefix",
  "managedRulesets"
];
const RULESET_KEYS = [
  "id",
  "name",
  "target",
  "enforcement",
  "conditions",
  "rules",
  "bypass_actors"
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(problems: string[]): PolicyError {
  return new PolicyError(
    `recovery snapshot is invalid: ${problems.join("; ")}`,
    "SNAPSHOT_INVALID"
  );
}

/**
 * Validates an untrusted snapshot value. Snapshots may only describe contract-managed rulesets, so
 * unknown keys (which could widen restore scope) and rulesets outside the recorded prefix are
 * rejected rather than ignored.
 */
export function parseSnapshot(value: unknown): RecoverySnapshot {
  if (!isRecord(value)) throw invalid(["snapshot must be a JSON object"]);
  const problems: string[] = [];
  for (const key of Object.keys(value).sort()) {
    if (!SNAPSHOT_KEYS.includes(key)) problems.push(`unknown key "${key}"`);
  }
  if (value.schemaVersion !== 1) problems.push("schemaVersion must be 1");
  const { repository, defaultBranch, managedNamePrefix, managedRulesets } = value;
  if (typeof repository !== "string" || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository)) {
    problems.push("repository must be an OWNER/REPO string");
  }
  if (typeof defaultBranch !== "string" || defaultBranch === "") {
    problems.push("defaultBranch must be a non-empty string");
  }
  if (typeof managedNamePrefix !== "string" || !/^[A-Za-z0-9._-]+\/$/.test(managedNamePrefix)) {
    problems.push('managedNamePrefix must be a namespace ending in "/"');
  }
  const rulesets: GitHubRuleset[] = [];
  if (!Array.isArray(managedRulesets)) {
    problems.push("managedRulesets must be an array");
  } else {
    managedRulesets.forEach((item: unknown, index) => {
      const label = `managedRulesets[${String(index)}]`;
      if (isRecord(item)) {
        for (const key of Object.keys(item).sort()) {
          if (!RULESET_KEYS.includes(key)) problems.push(`unknown key "${key}" in ${label}`);
        }
      }
      const ruleset = parseRulesetResponse(item);
      if (!ruleset) {
        problems.push(`${label} is not a valid ruleset`);
        return;
      }
      if (typeof managedNamePrefix === "string" && !ruleset.name.startsWith(managedNamePrefix)) {
        problems.push(`${label} is outside the managed prefix`);
      }
      if (rulesets.some((existing) => existing.name === ruleset.name)) {
        problems.push(`${label} duplicates managed ruleset name "${ruleset.name}"`);
      }
      rulesets.push(ruleset);
    });
  }
  if (problems.length > 0) throw invalid(problems);
  return {
    schemaVersion: 1,
    repository: repository as string,
    defaultBranch: defaultBranch as string,
    managedNamePrefix: managedNamePrefix as string,
    managedRulesets: rulesets
  };
}

/** Serializes a snapshot; refuses to persist anything that looks like credential material. */
export function serializeSnapshot(snapshot: RecoverySnapshot): string {
  const text = stableJson(parseSnapshot(snapshot));
  if (redactSensitive(text) !== text) {
    throw new PolicyError(
      "refusing to write a snapshot containing credential-like material",
      "SNAPSHOT_UNSAFE"
    );
  }
  return text;
}

/**
 * Writes the snapshot with owner-only permissions. An existing snapshot is never overwritten, so the
 * earliest unrecovered pre-change state is kept; an operator archives it before the next rollout.
 */
export async function writeSnapshot(path: string, snapshot: RecoverySnapshot): Promise<void> {
  const text = serializeSnapshot(snapshot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new PolicyError(
        "a recovery snapshot already exists; archive or remove it before applying new changes",
        "SNAPSHOT_EXISTS"
      );
    }
    throw new PolicyError("unable to write the recovery snapshot", "SNAPSHOT_WRITE_FAILED");
  }
}

export async function readSnapshot(path: string): Promise<RecoverySnapshot> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new PolicyError("recovery snapshot is missing", "SNAPSHOT_MISSING");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new PolicyError("recovery snapshot is invalid: not valid JSON", "SNAPSHOT_INVALID");
  }
  return parseSnapshot(value);
}
