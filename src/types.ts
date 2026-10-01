export type MergeMethod = "merge" | "squash" | "rebase";
export type Enforcement = "active" | "evaluate" | "disabled";
export type BypassActorType = "RepositoryRole" | "Team" | "Integration" | "OrganizationAdmin";
export type BypassMode = "always" | "pull_request";

export interface ContractRules {
  requirePullRequest: boolean;
  requiredApprovals: number;
  requireResolvedConversations: boolean;
  requireStatusChecks: string[];
  strictStatusChecks: boolean;
  requireLinearHistory: boolean;
  blockForcePushes: boolean;
  blockDeletions: boolean;
}

export interface ContractBypassActor {
  actorId: number;
  actorType: BypassActorType;
  bypassMode: BypassMode;
}

export interface ContractRuleset {
  name: string;
  target: "branch";
  enforcement: Enforcement;
  branches: string[];
  bypassActors: ContractBypassActor[];
  rules: ContractRules;
}

export interface GovernanceContract {
  version: 1;
  managedNamePrefix: string;
  defaultBranch: string;
  mergeMethod: MergeMethod;
  rulesets: ContractRuleset[];
}

export type RulesetRule = Record<string, unknown> & { type: string };

export interface GitHubRuleset {
  id: number;
  name: string;
  target: "branch" | "tag" | "push";
  enforcement: Enforcement;
  conditions: {
    ref_name: {
      include: string[];
      exclude: string[];
    };
  };
  rules: RulesetRule[];
  bypass_actors: Record<string, unknown>[];
}

/** A ruleset request body: everything GitHub accepts on create/update, without the id. */
export type RulesetBody = Omit<GitHubRuleset, "id">;

export interface RulesetSummary {
  id: number;
  name: string;
}

export interface RepositoryState {
  owner: string;
  repository: string;
  defaultBranch: string;
  /** Whether the default branch also carries classic (non-ruleset) branch protection. */
  defaultBranchClassicProtection: boolean;
  rulesets: GitHubRuleset[];
  workflowChecks: string[];
}

export type PlanAction =
  | { kind: "create"; name: string; desired: RulesetBody }
  | { kind: "update"; name: string; rulesetId: number; changes: string[]; desired: RulesetBody }
  | { kind: "delete"; name: string; rulesetId: number; reason: "obsolete" | "duplicate" };

export interface GovernancePlan {
  schemaVersion: 1;
  repository: string;
  defaultBranch: string;
  defaultBranchClassicProtection: boolean;
  managedNamePrefix: string;
  requiredStatusChecks: string[];
  configuredWorkflowChecks: string[];
  actions: PlanAction[];
  preservedUnmanagedRulesets: string[];
  warnings: string[];
  blockers: string[];
}

export interface RecoverySnapshot {
  schemaVersion: 1;
  repository: string;
  defaultBranch: string;
  managedNamePrefix: string;
  managedRulesets: GitHubRuleset[];
}

export interface TransportResponse<T> {
  status: number;
  headers: Record<string, string>;
  body: T;
}

export interface GitHubTransport {
  request<T>(method: string, path: string, body?: unknown): Promise<TransportResponse<T>>;
}
