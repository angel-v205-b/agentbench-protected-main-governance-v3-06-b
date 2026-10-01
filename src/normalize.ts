import { DEFAULT_BRANCH_SELECTOR } from "./contract.js";
import type {
  ContractRuleset,
  Enforcement,
  GitHubRuleset,
  MergeMethod,
  RulesetBody,
  RulesetRule
} from "./types.js";

const TARGETS: readonly GitHubRuleset["target"][] = ["branch", "tag", "push"];
const ENFORCEMENTS: readonly Enforcement[] = ["active", "evaluate", "disabled"];

export function desiredRuleset(
  contract: ContractRuleset,
  defaultBranch: string,
  mergeMethod?: MergeMethod
): GitHubRuleset {
  const include = contract.branches.map((branch) =>
    branch === DEFAULT_BRANCH_SELECTOR ? `refs/heads/${defaultBranch}` : branch
  );
  const rules: GitHubRuleset["rules"] = [];
  if (contract.rules.blockDeletions) rules.push({ type: "deletion" });
  if (contract.rules.blockForcePushes) rules.push({ type: "non_fast_forward" });
  if (contract.rules.requireLinearHistory) rules.push({ type: "required_linear_history" });
  if (contract.rules.requirePullRequest) {
    rules.push({
      type: "pull_request",
      parameters: {
        required_approving_review_count: contract.rules.requiredApprovals,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: contract.rules.requireResolvedConversations,
        ...(mergeMethod === undefined ? {} : { allowed_merge_methods: [mergeMethod] })
      }
    });
  }
  if (contract.rules.requireStatusChecks.length > 0) {
    rules.push({
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: contract.rules.strictStatusChecks,
        do_not_enforce_on_create: false,
        required_status_checks: contract.rules.requireStatusChecks.map((context) => ({ context }))
      }
    });
  }

  return {
    id: 0,
    name: contract.name,
    target: contract.target,
    enforcement: contract.enforcement,
    conditions: { ref_name: { include, exclude: [] } },
    rules,
    bypass_actors: contract.bypassActors.map((actor) => ({
      actor_id: actor.actorId,
      actor_type: actor.actorType,
      bypass_mode: actor.bypassMode
    }))
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Validates a ruleset returned by GitHub and reduces it to the fields this tool manages. Volatile
 * or descriptive metadata (node ids, links, timestamps, current_user_can_bypass) is dropped so
 * that snapshots and plans stay deterministic. Returns undefined when the shape is malformed.
 */
export function parseRulesetResponse(value: unknown): GitHubRuleset | undefined {
  if (!isRecord(value)) return undefined;
  const { id, name, target, enforcement } = value;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return undefined;
  if (typeof name !== "string" || name === "") return undefined;
  if (!TARGETS.includes(target as GitHubRuleset["target"])) return undefined;
  if (!ENFORCEMENTS.includes(enforcement as Enforcement)) return undefined;

  let include: string[] = [];
  let exclude: string[] = [];
  if (value.conditions !== undefined && value.conditions !== null) {
    if (!isRecord(value.conditions)) return undefined;
    const refName = value.conditions.ref_name;
    if (refName !== undefined) {
      if (!isRecord(refName)) return undefined;
      if (!isStringArray(refName.include) || !isStringArray(refName.exclude)) return undefined;
      include = [...refName.include];
      exclude = [...refName.exclude];
    }
  }

  const rawRules = value.rules ?? [];
  if (!Array.isArray(rawRules)) return undefined;
  const rules: RulesetRule[] = [];
  for (const rule of rawRules) {
    if (!isRecord(rule) || typeof rule.type !== "string") return undefined;
    if (rule.parameters !== undefined && !isRecord(rule.parameters)) return undefined;
    rules.push(
      rule.parameters === undefined
        ? { type: rule.type }
        : { type: rule.type, parameters: structuredClone(rule.parameters) }
    );
  }

  const rawActors = value.bypass_actors ?? [];
  if (!Array.isArray(rawActors) || !rawActors.every(isRecord)) return undefined;
  const bypass_actors = rawActors.map((actor) => ({
    actor_id: actor.actor_id ?? null,
    actor_type: actor.actor_type,
    bypass_mode: actor.bypass_mode
  }));

  return {
    id,
    name,
    target: target as GitHubRuleset["target"],
    enforcement: enforcement as Enforcement,
    conditions: { ref_name: { include, exclude } },
    rules,
    bypass_actors
  };
}

export function rulesetBody(ruleset: GitHubRuleset | RulesetBody): RulesetBody {
  return {
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    conditions: structuredClone(ruleset.conditions),
    rules: structuredClone(ruleset.rules),
    bypass_actors: structuredClone(ruleset.bypass_actors)
  };
}

/**
 * Canonicalizes rule parameters so that values GitHub treats as defaults (false, 0, null, empty
 * strings and empty arrays) compare equal to an omitted key, and arrays of scalars or of status
 * checks compare independently of order.
 */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(canonicalValue).map((item) => JSON.stringify(item));
    return items.sort().map((item) => JSON.parse(item) as unknown);
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, item]) => !isDefaultValue(item))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonicalValue(item)]);
    return Object.fromEntries(entries);
  }
  return value;
}

function isDefaultValue(value: unknown): boolean {
  return (
    value === false ||
    value === null ||
    value === 0 ||
    value === "" ||
    value === undefined ||
    (Array.isArray(value) && value.length === 0)
  );
}

interface CanonicalParts {
  identity: string;
  enforcement: string;
  conditions: string;
  bypass_actors: string;
  /** Canonical parameters per rule plus the parameter names the ruleset states explicitly. */
  rules: Map<string, { parameters: Record<string, unknown>; stated: string[] }>;
}

function canonicalParts(ruleset: GitHubRuleset | RulesetBody): CanonicalParts {
  const rules: CanonicalParts["rules"] = new Map();
  const counts = new Map<string, number>();
  for (const rule of ruleset.rules) {
    const count = (counts.get(rule.type) ?? 0) + 1;
    counts.set(rule.type, count);
    const key = count === 1 ? rule.type : `${rule.type}#${String(count)}`;
    const parameters = (rule.parameters ?? {}) as Record<string, unknown>;
    rules.set(key, {
      parameters: canonicalValue(parameters) as Record<string, unknown>,
      stated: Object.keys(parameters)
    });
  }
  return {
    identity: JSON.stringify([ruleset.name, ruleset.target]),
    enforcement: ruleset.enforcement,
    conditions: JSON.stringify(canonicalValue(ruleset.conditions.ref_name)),
    bypass_actors: JSON.stringify(
      ruleset.bypass_actors
        .map((actor) => JSON.stringify([actor.actor_type, actor.actor_id, actor.bypass_mode]))
        .sort()
    ),
    rules
  };
}

/** Lists the managed fields that differ between a live ruleset and the desired body. */
export function rulesetDifferences(
  live: GitHubRuleset | RulesetBody,
  desired: GitHubRuleset | RulesetBody
): string[] {
  const left = canonicalParts(live);
  const right = canonicalParts(desired);
  const changes: string[] = [];
  if (left.identity !== right.identity) changes.push("target");
  if (left.enforcement !== right.enforcement) changes.push("enforcement");
  if (left.conditions !== right.conditions) changes.push("conditions");
  if (left.bypass_actors !== right.bypass_actors) changes.push("bypass_actors");
  const ruleTypes = [...new Set([...left.rules.keys(), ...right.rules.keys()])].sort();
  for (const type of ruleTypes) {
    const current = left.rules.get(type);
    const wanted = right.rules.get(type);
    if (current === undefined) changes.push(`rules.${type}:add`);
    else if (wanted === undefined) changes.push(`rules.${type}:remove`);
    else {
      // Only parameters the desired body states are managed; parameters GitHub adds on its own
      // (new API defaults) are outside the contract and are not treated as drift.
      const keys = wanted.stated
        .filter(
          (key) =>
            JSON.stringify(current.parameters[key]) !== JSON.stringify(wanted.parameters[key])
        )
        .sort();
      if (keys.length > 0) changes.push(`rules.${type}:change(${keys.join(",")})`);
    }
  }
  return changes;
}

export function rulesetsEquivalent(
  live: GitHubRuleset | RulesetBody,
  desired: GitHubRuleset | RulesetBody
): boolean {
  return rulesetDifferences(live, desired).length === 0;
}
