import { resolve } from "node:path";
import { writePlanArtifacts } from "./artifacts.js";
import { readToken } from "./auth.js";
import { loadContract } from "./contract.js";
import { PolicyError } from "./errors.js";
import { FetchGitHubTransport, GitHubClient } from "./github.js";
import { buildPlan, isCompliant, isManagedName } from "./planner.js";
import {
  applyPlan,
  restoreSnapshot,
  type ReconcileResult,
  type SnapshotStore
} from "./reconciler.js";
import { resolveRepositoryFromOrigin } from "./remote.js";
import { readSnapshot, writeSnapshot } from "./snapshot.js";
import type {
  GitHubTransport,
  GovernanceContract,
  GovernancePlan,
  RepositoryState,
  TransportResponse
} from "./types.js";

export interface RuntimeOptions {
  cwd?: string;
  contractPath?: string;
  snapshotPath?: string;
  /** Overrides the HTTP transport (used by tests); when omitted the token file is read. */
  transport?: GitHubTransport;
}

export const PLAN_JSON = "artifacts/governance-plan.json";
export const PLAN_MARKDOWN = "artifacts/governance-plan.md";
export const SNAPSHOT_FILE = "artifacts/recovery-snapshot.json";

/** Counts requests by method so commands can report (and tests can assert) remote writes. */
export class CountingTransport implements GitHubTransport {
  public reads = 0;
  public writes = 0;

  public constructor(private readonly inner: GitHubTransport) {}

  public request<T>(method: string, path: string, body?: unknown): Promise<TransportResponse<T>> {
    if (method === "GET") this.reads += 1;
    else this.writes += 1;
    return this.inner.request<T>(method, path, body);
  }
}

class ReadOnlyTransport implements GitHubTransport {
  public constructor(private readonly inner: GitHubTransport) {}

  public request<T>(method: string, path: string, body?: unknown): Promise<TransportResponse<T>> {
    if (method !== "GET") {
      return Promise.reject(
        new PolicyError(`read-only command attempted a ${method} request`, "READ_ONLY_VIOLATION")
      );
    }
    return this.inner.request<T>(method, path, body);
  }
}

interface Context {
  cwd: string;
  snapshotPath: string;
  contract: GovernanceContract;
  client: GitHubClient;
  counter: CountingTransport;
  owner: string;
  repository: string;
}

async function liveContext(options: RuntimeOptions, readOnly: boolean): Promise<Context> {
  const cwd = options.cwd ?? process.cwd();
  const contractPath = options.contractPath ?? resolve(cwd, "governance-contract.json");
  const snapshotPath = options.snapshotPath ?? resolve(cwd, SNAPSHOT_FILE);
  const { owner, repository } = resolveRepositoryFromOrigin(cwd);
  const contract = await loadContract(contractPath);
  const base = options.transport ?? new FetchGitHubTransport(await readToken());
  const counter = new CountingTransport(readOnly ? new ReadOnlyTransport(base) : base);
  const client = new GitHubClient(owner, repository, counter);
  return { cwd, snapshotPath, contract, client, counter, owner, repository };
}

export async function readState(
  owner: string,
  repository: string,
  client: GitHubClient
): Promise<RepositoryState> {
  const defaultBranch = await client.getDefaultBranch();
  const [branch, summaries, workflowChecks] = await Promise.all([
    client.getBranch(defaultBranch),
    client.listRulesets(),
    client.listWorkflowCheckNames(defaultBranch)
  ]);
  const rulesets = [];
  for (const summary of [...summaries].sort((left, right) => left.id - right.id)) {
    rulesets.push(await client.getRuleset(summary.id));
  }
  return {
    owner,
    repository,
    defaultBranch,
    defaultBranchClassicProtection: branch.protected,
    rulesets,
    workflowChecks
  };
}

export interface CommandResult {
  plan: GovernancePlan;
  remoteWrites: number;
}

export async function plan(options: RuntimeOptions = {}): Promise<CommandResult> {
  const context = await liveContext(options, true);
  const state = await readState(context.owner, context.repository, context.client);
  const result = buildPlan(context.contract, state);
  await writePlanArtifacts(
    result,
    resolve(context.cwd, PLAN_JSON),
    resolve(context.cwd, PLAN_MARKDOWN)
  );
  return { plan: result, remoteWrites: context.counter.writes };
}

export interface ApplyResult extends CommandResult {
  changes: ReconcileResult;
}

export async function apply(options: RuntimeOptions = {}): Promise<ApplyResult> {
  const context = await liveContext(options, false);
  const state = await readState(context.owner, context.repository, context.client);
  const result = buildPlan(context.contract, state);
  const snapshotStore: SnapshotStore = {
    save: (snapshot) => writeSnapshot(context.snapshotPath, snapshot),
    load: () => readSnapshot(context.snapshotPath)
  };
  const changes = await applyPlan(
    context.client,
    context.contract,
    result,
    state.rulesets,
    snapshotStore
  );
  if (result.actions.length > 0) {
    const after = buildPlan(
      context.contract,
      await readState(context.owner, context.repository, context.client)
    );
    if (!isCompliant(after)) {
      throw new PolicyError(
        `apply finished but live policy still differs from the contract (${String(after.actions.length)} change(s))`,
        "POLICY_DRIFT"
      );
    }
  }
  return { plan: result, changes, remoteWrites: context.counter.writes };
}

export async function verify(options: RuntimeOptions = {}): Promise<CommandResult> {
  const context = await liveContext(options, true);
  const state = await readState(context.owner, context.repository, context.client);
  const result = buildPlan(context.contract, state);
  if (!isCompliant(result)) {
    const details = [
      ...result.actions.map((action) => `${action.kind} ${action.name}`),
      ...result.blockers
    ];
    throw new PolicyError(
      `live policy differs from the contract (${String(result.actions.length)} change(s) required): ${details.join("; ")}`,
      "POLICY_DRIFT"
    );
  }
  return { plan: result, remoteWrites: context.counter.writes };
}

export interface RestoreResult {
  changes: ReconcileResult;
  remoteWrites: number;
}

export async function restore(options: RuntimeOptions = {}): Promise<RestoreResult> {
  const cwd = options.cwd ?? process.cwd();
  // Validate the snapshot before any credential is read or remote request is made.
  const snapshot = await readSnapshot(options.snapshotPath ?? resolve(cwd, SNAPSHOT_FILE));
  const context = await liveContext(options, false);
  const summaries = await context.client.listRulesets();
  const current = [];
  for (const summary of [...summaries].sort((left, right) => left.id - right.id)) {
    if (isManagedName(summary.name, context.contract.managedNamePrefix)) {
      current.push(await context.client.getRuleset(summary.id));
    }
  }
  const changes = await restoreSnapshot(context.client, context.contract, snapshot, current);
  return { changes, remoteWrites: context.counter.writes };
}
