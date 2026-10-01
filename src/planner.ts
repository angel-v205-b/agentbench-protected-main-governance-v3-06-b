import { desiredRuleset, rulesetBody, rulesetDifferences } from "./normalize.js";
import type {
  GitHubRuleset,
  GovernanceContract,
  GovernancePlan,
  PlanAction,
  RepositoryState
} from "./types.js";

export function isManagedName(name: string, prefix: string): boolean {
  return name.startsWith(prefix);
}

function byName(left: { name: string }, right: { name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

/**
 * Computes the minimum set of managed ruleset writes needed to satisfy the contract. Creates and
 * updates are always ordered before deletes so a replacement exists before anything obsolete is
 * removed. The result is a pure function of its inputs (no timestamps), so repeated planning
 * against unchanged remote state is byte-identical.
 */
export function buildPlan(contract: GovernanceContract, state: RepositoryState): GovernancePlan {
  const prefix = contract.managedNamePrefix;
  const managed = state.rulesets
    .filter((ruleset) => isManagedName(ruleset.name, prefix))
    .sort((left, right) => left.id - right.id);
  const unmanaged = state.rulesets.filter((ruleset) => !isManagedName(ruleset.name, prefix));
  const upserts: PlanAction[] = [];
  const deletes: PlanAction[] = [];
  const contractNames = new Set(contract.rulesets.map((ruleset) => ruleset.name));

  for (const expected of contract.rulesets) {
    const desired = rulesetBody(
      desiredRuleset(expected, state.defaultBranch, contract.mergeMethod)
    );
    const matches = managed.filter((ruleset) => ruleset.name === expected.name);
    const [first] = matches;
    if (first === undefined) {
      upserts.push({ kind: "create", name: expected.name, desired });
      continue;
    }
    const keeper: GitHubRuleset =
      matches.find((ruleset) => rulesetDifferences(ruleset, desired).length === 0) ?? first;
    const changes = rulesetDifferences(keeper, desired);
    if (changes.length > 0) {
      upserts.push({ kind: "update", name: expected.name, rulesetId: keeper.id, changes, desired });
    }
    for (const duplicate of matches) {
      if (duplicate.id !== keeper.id) {
        deletes.push({
          kind: "delete",
          name: duplicate.name,
          rulesetId: duplicate.id,
          reason: "duplicate"
        });
      }
    }
  }

  for (const current of managed) {
    if (!contractNames.has(current.name)) {
      deletes.push({
        kind: "delete",
        name: current.name,
        rulesetId: current.id,
        reason: "obsolete"
      });
    }
  }
  deletes.sort(
    (left, right) =>
      byName(left, right) ||
      (left.kind === "delete" && right.kind === "delete" ? left.rulesetId - right.rulesetId : 0)
  );

  const requiredStatusChecks = [
    ...new Set(contract.rulesets.flatMap((ruleset) => ruleset.rules.requireStatusChecks))
  ].sort();
  const configuredWorkflowChecks = [...new Set(state.workflowChecks)].sort();
  const blockers = requiredStatusChecks
    .filter((check) => !configuredWorkflowChecks.includes(check))
    .map(
      (check) =>
        `required status check "${check}" is not produced by any workflow job on the default branch`
    );
  const warnings: string[] = [];
  if (contract.defaultBranch !== state.defaultBranch) {
    warnings.push(
      `contract expects default branch "${contract.defaultBranch}" but the repository uses "${state.defaultBranch}"; the live default branch is targeted`
    );
  }
  if (state.defaultBranchClassicProtection) {
    warnings.push(
      "the default branch also has classic branch protection, which this tool does not manage"
    );
  }

  return {
    schemaVersion: 1,
    repository: `${state.owner}/${state.repository}`,
    defaultBranch: state.defaultBranch,
    defaultBranchClassicProtection: state.defaultBranchClassicProtection,
    managedNamePrefix: prefix,
    requiredStatusChecks,
    configuredWorkflowChecks,
    actions: [...upserts, ...deletes],
    preservedUnmanagedRulesets: [...new Set(unmanaged.map((ruleset) => ruleset.name))].sort(),
    warnings,
    blockers
  };
}

export function isCompliant(plan: GovernancePlan): boolean {
  return plan.actions.length === 0 && plan.blockers.length === 0;
}
