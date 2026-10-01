import { readFile } from "node:fs/promises";
import { ContractValidationError } from "./errors.js";
import type {
  BypassActorType,
  BypassMode,
  ContractBypassActor,
  ContractRules,
  ContractRuleset,
  Enforcement,
  GovernanceContract,
  MergeMethod
} from "./types.js";

export const DEFAULT_BRANCH_SELECTOR = "~DEFAULT_BRANCH";

const CONTRACT_KEYS = ["version", "managedNamePrefix", "defaultBranch", "mergeMethod", "rulesets"];
const RULESET_KEYS = ["name", "target", "enforcement", "branches", "bypassActors", "rules"];
const RULE_KEYS = [
  "requirePullRequest",
  "requiredApprovals",
  "requireResolvedConversations",
  "requireStatusChecks",
  "strictStatusChecks",
  "requireLinearHistory",
  "blockForcePushes",
  "blockDeletions"
];
const BYPASS_KEYS = ["actorId", "actorType", "bypassMode"];
const MERGE_METHODS: readonly MergeMethod[] = ["merge", "squash", "rebase"];
const ENFORCEMENTS: readonly Enforcement[] = ["active", "evaluate", "disabled"];
const ACTOR_TYPES: readonly BypassActorType[] = [
  "RepositoryRole",
  "Team",
  "Integration",
  "OrganizationAdmin"
];
const BYPASS_MODES: readonly BypassMode[] = ["always", "pull_request"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new ContractValidationError(message);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  noun = "key"
): void {
  for (const key of Object.keys(value).sort()) {
    if (!allowed.includes(key)) fail(`unknown ${noun} "${key}" in ${path}`);
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${path} must be a non-empty string`);
  }
  if (value !== value.trim()) fail(`${path} must not have surrounding whitespace`);
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(`${path} must be a boolean`);
  return value;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(`${path} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

/** Validates a branch name using the subset of git-check-ref-format rules that matter here. */
function isValidRefComponentPath(name: string): boolean {
  if (name === "" || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) {
    return false;
  }
  if (name.includes("//") || name.includes("..") || name.includes("@{")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20~^:\\\x7f]/.test(name)) return false;
  return name.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

function validateBranchName(value: unknown, path: string): string {
  const name = requireString(value, path);
  if (/[*?[]/.test(name) || !isValidRefComponentPath(name)) {
    fail(`${path} is not a valid branch name`);
  }
  return name;
}

function validateBranchSelector(value: unknown, path: string): string {
  const selector = requireString(value, path);
  if (selector === DEFAULT_BRANCH_SELECTOR) return selector;
  if (selector.startsWith("~")) {
    fail(`${path} uses unsupported or unsafe wildcard selector "${selector}"`);
  }
  if (!selector.startsWith("refs/heads/")) {
    fail(`${path} must be "${DEFAULT_BRANCH_SELECTOR}" or a "refs/heads/..." branch selector`);
  }
  const branch = selector.slice("refs/heads/".length);
  if (!isValidRefComponentPath(branch.replace(/[*?]/g, "x"))) {
    fail(`${path} is a malformed branch selector`);
  }
  const segments = branch.split("/");
  const firstWildcard = segments.findIndex((segment) => /[*?[]/.test(segment));
  if (branch.includes("[")) fail(`${path} uses unsupported character classes`);
  if (firstWildcard === 0) {
    fail(`${path} is an unsafe wildcard target; wildcards need a literal leading path segment`);
  }
  if (segments.some((segment) => segment.includes("**") && segment !== "**")) {
    fail(`${path} is a malformed branch selector`);
  }
  return selector;
}

function parseStatusChecks(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(`${path} must be an array of strings`);
  const checks = value.map((check, index) => {
    if (typeof check !== "string") fail(`${path} must be an array of strings`);
    if (check.trim() === "") {
      fail(`${path}[${String(index)}]: status check names must be non-empty`);
    }
    if (check !== check.trim()) {
      fail(`${path}[${String(index)}]: status check names must not have surrounding whitespace`);
    }
    return check;
  });
  const duplicate = checks.find((check, index) => checks.indexOf(check) !== index);
  if (duplicate !== undefined) fail(`${path} contains duplicate status check "${duplicate}"`);
  return checks;
}

function parseRules(value: unknown, path: string): ContractRules {
  if (!isRecord(value)) fail(`${path} must be an object`);
  rejectUnknownKeys(value, RULE_KEYS, path, "rule type");
  for (const key of RULE_KEYS) {
    if (!(key in value)) fail(`${path}.${key} is required`);
  }
  const approvals = value.requiredApprovals;
  if (
    typeof approvals !== "number" ||
    !Number.isInteger(approvals) ||
    approvals < 0 ||
    approvals > 10
  ) {
    fail(`${path}.requiredApprovals must be an integer between 0 and 10`);
  }
  const rules: ContractRules = {
    requirePullRequest: requireBoolean(value.requirePullRequest, `${path}.requirePullRequest`),
    requiredApprovals: approvals,
    requireResolvedConversations: requireBoolean(
      value.requireResolvedConversations,
      `${path}.requireResolvedConversations`
    ),
    requireStatusChecks: parseStatusChecks(
      value.requireStatusChecks,
      `${path}.requireStatusChecks`
    ),
    strictStatusChecks: requireBoolean(value.strictStatusChecks, `${path}.strictStatusChecks`),
    requireLinearHistory: requireBoolean(
      value.requireLinearHistory,
      `${path}.requireLinearHistory`
    ),
    blockForcePushes: requireBoolean(value.blockForcePushes, `${path}.blockForcePushes`),
    blockDeletions: requireBoolean(value.blockDeletions, `${path}.blockDeletions`)
  };
  if (
    !rules.requirePullRequest &&
    (rules.requiredApprovals > 0 || rules.requireResolvedConversations)
  ) {
    fail(
      `${path} has conflicting policies: review requirements need requirePullRequest to be true`
    );
  }
  if (rules.strictStatusChecks && rules.requireStatusChecks.length === 0) {
    fail(`${path} has conflicting policies: strictStatusChecks needs at least one status check`);
  }
  return rules;
}

function parseBypassActor(value: unknown, path: string): ContractBypassActor {
  if (!isRecord(value)) fail(`${path} must be an object`);
  rejectUnknownKeys(value, BYPASS_KEYS, path);
  const actorId = value.actorId;
  if (typeof actorId !== "number" || !Number.isInteger(actorId) || actorId <= 0) {
    fail(`${path}.actorId must be a positive integer`);
  }
  return {
    actorId,
    actorType: requireEnum(value.actorType, ACTOR_TYPES, `${path}.actorType`),
    bypassMode: requireEnum(value.bypassMode, BYPASS_MODES, `${path}.bypassMode`)
  };
}

function parseRuleset(value: unknown, index: number, prefix: string): ContractRuleset {
  const path = `rulesets[${String(index)}]`;
  if (!isRecord(value)) fail(`${path} must be an object`);
  rejectUnknownKeys(value, RULESET_KEYS, path);
  const name = requireString(value.name, `${path}.name`);
  if (!name.startsWith(prefix)) {
    fail(`ruleset ${name} is outside the managed prefix "${prefix}"`);
  }
  if (name.length === prefix.length || name.length > 100) {
    fail(`${path}.name must extend the managed prefix and be at most 100 characters`);
  }
  if (value.target !== "branch") fail(`${path}.target must be "branch"`);
  if (!Array.isArray(value.branches) || value.branches.length === 0) {
    fail(`${path}.branches must be a non-empty array`);
  }
  const branches = value.branches.map((branch, branchIndex) =>
    validateBranchSelector(branch, `${path}.branches[${String(branchIndex)}]`)
  );
  const duplicateBranch = branches.find((branch, i) => branches.indexOf(branch) !== i);
  if (duplicateBranch !== undefined) {
    fail(`${path}.branches contains duplicate selector "${duplicateBranch}"`);
  }
  if (!Array.isArray(value.bypassActors)) fail(`${path}.bypassActors must be an array`);
  const bypassActors = value.bypassActors.map((actor, actorIndex) =>
    parseBypassActor(actor, `${path}.bypassActors[${String(actorIndex)}]`)
  );
  const actorKeys = bypassActors.map((actor) => `${actor.actorType}:${String(actor.actorId)}`);
  const duplicateActor = actorKeys.find((key, i) => actorKeys.indexOf(key) !== i);
  if (duplicateActor !== undefined) {
    fail(`${path}.bypassActors contains duplicate actor ${duplicateActor}`);
  }
  return {
    name,
    target: "branch",
    enforcement: requireEnum(value.enforcement, ENFORCEMENTS, `${path}.enforcement`),
    branches,
    bypassActors,
    rules: parseRules(value.rules, `${path}.rules`)
  };
}

export function parseContract(value: unknown): GovernanceContract {
  if (!isRecord(value)) fail("contract must be an object");
  if (value.version !== 1) fail("unsupported contract version (expected 1)");
  rejectUnknownKeys(value, CONTRACT_KEYS, "contract", "contract key");
  const managedNamePrefix = requireString(value.managedNamePrefix, "managedNamePrefix");
  if (!/^[A-Za-z0-9._-]+\/$/.test(managedNamePrefix)) {
    fail('managedNamePrefix must be a literal namespace ending in "/" (for example "team/")');
  }
  const defaultBranch = validateBranchName(value.defaultBranch, "defaultBranch");
  const mergeMethod = requireEnum(value.mergeMethod, MERGE_METHODS, "mergeMethod");
  if (!Array.isArray(value.rulesets) || value.rulesets.length === 0) {
    fail("rulesets must be a non-empty array");
  }
  const rulesets = value.rulesets.map((ruleset, index) =>
    parseRuleset(ruleset, index, managedNamePrefix)
  );

  const names = new Set<string>();
  const selectors = new Map<string, string>();
  for (const ruleset of rulesets) {
    if (names.has(ruleset.name)) fail(`duplicate managed ruleset name "${ruleset.name}"`);
    names.add(ruleset.name);
    for (const branch of ruleset.branches) {
      const owner = selectors.get(branch);
      if (owner !== undefined) {
        fail(
          `conflicting policies: "${owner}" and "${ruleset.name}" both manage branch selector "${branch}"`
        );
      }
      selectors.set(branch, ruleset.name);
    }
    if (ruleset.rules.requireLinearHistory && mergeMethod === "merge") {
      fail(
        `conflicting policies: ${ruleset.name} requires linear history but mergeMethod is "merge"`
      );
    }
  }

  return { version: 1, managedNamePrefix, defaultBranch, mergeMethod, rulesets };
}

export async function loadContract(path: string): Promise<GovernanceContract> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw new ContractValidationError("governance contract file could not be read");
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new ContractValidationError("contract is not valid JSON");
  }
  return parseContract(value);
}
