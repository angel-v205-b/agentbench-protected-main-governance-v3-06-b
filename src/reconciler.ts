import { PolicyError } from "./errors.js";
import type { GitHubClient } from "./github.js";
import { rulesetBody, rulesetDifferences } from "./normalize.js";
import { isManagedName } from "./planner.js";
import { safeErrorMessage } from "./redaction.js";
import type {
  GitHubRuleset,
  GovernanceContract,
  GovernancePlan,
  PlanAction,
  RecoverySnapshot,
  RulesetBody
} from "./types.js";

export interface SnapshotStore {
  save(snapshot: RecoverySnapshot): Promise<void>;
  load(): Promise<RecoverySnapshot>;
}

export interface ReconcileResult {
  created: string[];
  updated: string[];
  deleted: string[];
}

type Upsert = Extract<PlanAction, { kind: "create" | "update" }>;
type Delete = Extract<PlanAction, { kind: "delete" }>;

type Applied =
  | { kind: "create"; id: number; name: string }
  | { kind: "update"; id: number; name: string; previous: RulesetBody | undefined };

/** Re-reads a ruleset written by this tool and fails unless it matches the intended body. */
async function verifyWritten(
  client: GitHubClient,
  id: number,
  desired: RulesetBody
): Promise<void> {
  const live = await client.getRuleset(id);
  const differences = rulesetDifferences(live, desired);
  if (live.name !== desired.name || differences.length > 0) {
    throw new PolicyError(
      `ruleset ${desired.name} failed independent verification (${differences.join(", ") || "name"})`,
      "VERIFY_FAILED"
    );
  }
}

/** Returns managed rulesets to their pre-change bodies, newest change first. */
async function rollBack(client: GitHubClient, applied: Applied[]): Promise<string[]> {
  const problems: string[] = [];
  for (const change of [...applied].reverse()) {
    try {
      if (change.kind === "create") {
        await client.deleteRuleset(change.id);
      } else if (change.previous) {
        await client.updateRuleset(change.id, change.previous);
        await verifyWritten(client, change.id, change.previous);
      }
    } catch (error) {
      problems.push(`${change.name}: ${safeErrorMessage(error)}`);
    }
  }
  return problems;
}

/**
 * Applies a plan in three phases:
 *  1. record the managed pre-change state (before any remote write);
 *  2. create/update replacements and independently verify each one;
 *  3. only then delete obsolete or duplicate managed rulesets.
 * If phase 2 fails, every change made so far is rolled back to the recorded state, so the
 * last verified managed policy stays in force and nothing obsolete has been removed.
 */
export async function applyPlan(
  client: GitHubClient,
  contract: GovernanceContract,
  plan: GovernancePlan,
  before: GitHubRuleset[],
  snapshots: SnapshotStore
): Promise<ReconcileResult> {
  const result: ReconcileResult = { created: [], updated: [], deleted: [] };
  if (plan.blockers.length > 0) {
    throw new PolicyError(
      `plan has blockers; refusing to apply: ${plan.blockers.join("; ")}`,
      "PLAN_BLOCKED"
    );
  }
  if (plan.actions.length === 0) return result;

  const managedBefore = before.filter((ruleset) =>
    isManagedName(ruleset.name, contract.managedNamePrefix)
  );
  for (const action of plan.actions) {
    if (!isManagedName(action.name, contract.managedNamePrefix)) {
      throw new PolicyError(
        `plan action targets unmanaged ruleset ${action.name}`,
        "UNMANAGED_TARGET"
      );
    }
    if (
      action.kind !== "create" &&
      !managedBefore.some((ruleset) => ruleset.id === action.rulesetId)
    ) {
      throw new PolicyError(
        `plan references managed ruleset ${action.name} that was not observed`,
        "STALE_PLAN"
      );
    }
  }

  await snapshots.save({
    schemaVersion: 1,
    repository: plan.repository,
    defaultBranch: plan.defaultBranch,
    managedNamePrefix: contract.managedNamePrefix,
    managedRulesets: managedBefore
  });

  const upserts = plan.actions.filter((action): action is Upsert => action.kind !== "delete");
  const deletes = plan.actions.filter((action): action is Delete => action.kind === "delete");
  const applied: Applied[] = [];
  try {
    for (const action of upserts) {
      if (action.kind === "create") {
        const created = await client.createRuleset(action.desired);
        applied.push({ kind: "create", id: created.id, name: action.name });
        await verifyWritten(client, created.id, action.desired);
        result.created.push(action.name);
      } else {
        const previous = managedBefore.find((ruleset) => ruleset.id === action.rulesetId);
        applied.push({
          kind: "update",
          id: action.rulesetId,
          name: action.name,
          previous: previous ? rulesetBody(previous) : undefined
        });
        await client.updateRuleset(action.rulesetId, action.desired);
        await verifyWritten(client, action.rulesetId, action.desired);
        result.updated.push(action.name);
      }
    }
  } catch (error) {
    const problems = await rollBack(client, applied);
    const outcome =
      problems.length === 0
        ? "managed rulesets were returned to the recorded pre-change state"
        : `rollback was incomplete (${problems.join("; ")}); run restore from the recovery snapshot`;
    throw new PolicyError(
      `apply stopped before deleting any obsolete managed ruleset: ${safeErrorMessage(error)}; ${outcome}`,
      "APPLY_FAILED"
    );
  }

  for (const action of deletes) {
    try {
      await client.deleteRuleset(action.rulesetId);
    } catch (error) {
      throw new PolicyError(
        `verified replacement policy is active, but deleting ${action.reason} ruleset ${action.name} failed: ${safeErrorMessage(error)}; re-run apply to finish`,
        "PARTIAL_APPLY"
      );
    }
    result.deleted.push(action.name);
  }
  return result;
}

/**
 * Restores contract-managed rulesets to the bodies recorded in a validated snapshot. Snapshot
 * rulesets are recreated or updated (and verified) first; managed rulesets absent from the snapshot
 * are deleted only after every restore write succeeded. Unmanaged rulesets are never touched.
 */
export async function restoreSnapshot(
  client: GitHubClient,
  contract: GovernanceContract,
  snapshot: RecoverySnapshot,
  current: GitHubRuleset[]
): Promise<ReconcileResult> {
  if (snapshot.managedNamePrefix !== contract.managedNamePrefix) {
    throw new PolicyError(
      "snapshot managed prefix does not match the contract",
      "SNAPSHOT_MISMATCH"
    );
  }
  if (snapshot.repository.toLowerCase() !== client.fullName.toLowerCase()) {
    throw new PolicyError(
      "snapshot repository mismatch: it was captured for a different repository",
      "SNAPSHOT_MISMATCH"
    );
  }
  const outside = snapshot.managedRulesets.find(
    (ruleset) => !isManagedName(ruleset.name, contract.managedNamePrefix)
  );
  if (outside) {
    throw new PolicyError(
      "snapshot contains a ruleset outside the managed prefix",
      "SNAPSHOT_MISMATCH"
    );
  }

  const result: ReconcileResult = { created: [], updated: [], deleted: [] };
  const managedNow = current
    .filter((ruleset) => isManagedName(ruleset.name, contract.managedNamePrefix))
    .sort((left, right) => left.id - right.id);
  const keep = new Set<number>();
  const progress = (): string =>
    `restored so far: created [${result.created.join(", ")}], updated [${result.updated.join(", ")}]`;

  const wanted = [...snapshot.managedRulesets].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  );
  for (const recorded of wanted) {
    const body = rulesetBody(recorded);
    const match = managedNow.find(
      (ruleset) => ruleset.name === recorded.name && !keep.has(ruleset.id)
    );
    try {
      if (match) {
        keep.add(match.id);
        if (rulesetDifferences(match, body).length > 0) {
          await client.updateRuleset(match.id, body);
          await verifyWritten(client, match.id, body);
          result.updated.push(recorded.name);
        }
      } else {
        const created = await client.createRuleset(body);
        keep.add(created.id);
        await verifyWritten(client, created.id, body);
        result.created.push(recorded.name);
      }
    } catch (error) {
      throw new PolicyError(
        `restore of ${recorded.name} failed: ${safeErrorMessage(error)}; no managed ruleset was deleted; ${progress()}`,
        "RESTORE_FAILED"
      );
    }
  }

  for (const ruleset of managedNow) {
    if (keep.has(ruleset.id)) continue;
    try {
      await client.deleteRuleset(ruleset.id);
    } catch (error) {
      throw new PolicyError(
        `recorded managed rulesets are restored, but deleting ${ruleset.name} failed: ${safeErrorMessage(error)}`,
        "RESTORE_FAILED"
      );
    }
    result.deleted.push(ruleset.name);
  }
  return result;
}
