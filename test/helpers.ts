import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseContract } from "../src/contract.js";
import { GitHubApiError } from "../src/errors.js";
import { desiredRuleset } from "../src/normalize.js";
import type {
  GitHubRuleset,
  GitHubTransport,
  GovernanceContract,
  GovernancePlan,
  PlanAction,
  RepositoryState,
  TransportResponse
} from "../src/types.js";

export function rawContractText(): string {
  return readFileSync(resolve("governance-contract.json"), "utf8");
}

export function contract(): GovernanceContract {
  return parseContract(JSON.parse(rawContractText()) as unknown);
}

export function expectedRuleset(id = 42): GitHubRuleset {
  const value = contract();
  return { ...desiredRuleset(value.rulesets[0]!, "main", value.mergeMethod), id };
}

export function legacyFixture(): GitHubRuleset[] {
  return JSON.parse(
    readFileSync(resolve("fixtures/legacy-rulesets.json"), "utf8")
  ) as GitHubRuleset[];
}

export function state(rulesets: GitHubRuleset[] = []): RepositoryState {
  return {
    owner: "octo-tester",
    repository: "agentbench-protected-main-governance",
    defaultBranch: "main",
    defaultBranchClassicProtection: false,
    workflowChecks: ["CI / package", "CI / test"],
    rulesets
  };
}

export function planOf(actions: PlanAction[], blockers: string[] = []): GovernancePlan {
  return {
    schemaVersion: 1,
    repository: "octo/repository",
    defaultBranch: "main",
    defaultBranchClassicProtection: false,
    managedNamePrefix: "agentbench/",
    requiredStatusChecks: ["CI / package", "CI / test"],
    configuredWorkflowChecks: ["CI / package", "CI / test"],
    actions,
    preservedUnmanagedRulesets: [],
    warnings: [],
    blockers
  };
}

export class RecordingTransport implements GitHubTransport {
  public readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];
  public readonly responses: Array<{
    status: number;
    headers?: Record<string, string>;
    body: unknown;
  }> = [];

  public queue(body: unknown, status = 200, headers: Record<string, string> = {}): void {
    this.responses.push({ status, headers, body });
  }

  public async request<T>(method: string, path: string, body?: unknown) {
    this.calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    const response = this.responses.shift();
    if (!response) throw new Error(`unexpected request: ${method} ${path}`);
    if (response.status >= 400) {
      throw new GitHubApiError(`fake ${method} ${path} failed`, response.status);
    }
    return {
      status: response.status,
      headers: response.headers ?? {},
      body: response.body as T
    };
  }
}

export const CI_WORKFLOW = `name: CI

on:
  pull_request:

jobs:
  test:
    name: CI / test
    runs-on: ubuntu-latest
    steps:
      - run: npm test
        name: not-a-job-name
  package:
    name: "CI / package"
    runs-on: ubuntu-latest
`;

interface Failure {
  method: string;
  match: RegExp;
  status: number;
  remaining: number;
}

/**
 * A small in-memory model of the GitHub REST endpoints the CLI uses. Responses carry the extra
 * metadata and defaulted parameters the real API returns so normalization is exercised.
 */
export class FakeGitHub implements GitHubTransport {
  public readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];
  public readonly rulesets = new Map<number, Record<string, unknown>>();
  public defaultBranch = "main";
  public classicProtection = false;
  public workflows: Record<string, string> = { "ci.yml": CI_WORKFLOW };
  public pageSize = 100;
  /** Optional hook that alters a ruleset body as GitHub stores it (to simulate drift). */
  public storeHook: ((body: Record<string, unknown>) => Record<string, unknown>) | undefined;
  private nextId = 500;
  private readonly failures: Failure[] = [];

  public constructor(
    public readonly owner = "octo",
    public readonly repository = "repository",
    initial: GitHubRuleset[] = []
  ) {
    for (const ruleset of initial)
      this.rulesets.set(
        ruleset.id,
        this.decorate(structuredClone(ruleset) as unknown as Record<string, unknown>)
      );
  }

  public failNext(method: string, match: RegExp, status = 500, times = 1): void {
    this.failures.push({ method, match, status, remaining: times });
  }

  public get writes(): Array<{ method: string; path: string; body?: unknown }> {
    return this.calls.filter((call) => call.method !== "GET");
  }

  public names(): string[] {
    return [...this.rulesets.values()].map((ruleset) => String(ruleset.name)).sort();
  }

  private decorate(ruleset: Record<string, unknown>): Record<string, unknown> {
    const id = Number(ruleset.id);
    const rules = (ruleset.rules as Array<Record<string, unknown>>).map((rule) => {
      if (rule.type !== "required_status_checks") return rule;
      const parameters = rule.parameters as Record<string, unknown>;
      return {
        ...rule,
        parameters: { do_not_enforce_on_create: false, ...parameters }
      };
    });
    return {
      ...ruleset,
      rules,
      source_type: "Repository",
      source: `${this.owner}/${this.repository}`,
      node_id: `RRS_${String(id)}`,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      current_user_can_bypass: "never",
      _links: { self: { href: `https://api.github.com/repos/x/y/rulesets/${String(id)}` } }
    };
  }

  public async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<TransportResponse<T>> {
    this.calls.push({
      method,
      path,
      ...(body === undefined ? {} : { body: structuredClone(body) })
    });
    const failure = this.failures.find((item) => item.method === method && item.match.test(path));
    if (failure) {
      failure.remaining -= 1;
      if (failure.remaining <= 0) this.failures.splice(this.failures.indexOf(failure), 1);
      throw new GitHubApiError(
        `GitHub ${method} ${path} failed (${String(failure.status)})`,
        failure.status
      );
    }
    const respond = (value: unknown, status = 200, headers: Record<string, string> = {}) => ({
      status,
      headers,
      body: structuredClone(value) as T
    });
    const base = `/repos/${this.owner}/${this.repository}`;
    const url = new URL(`https://api.github.com${path}`);
    const route = url.pathname;

    if (method === "GET" && route === base) {
      return respond({
        full_name: `${this.owner}/${this.repository}`,
        default_branch: this.defaultBranch
      });
    }
    if (
      method === "GET" &&
      route === `${base}/branches/${encodeURIComponent(this.defaultBranch)}`
    ) {
      return respond({ name: this.defaultBranch, protected: this.classicProtection });
    }
    if (method === "GET" && route === `${base}/contents/.github/workflows`) {
      return respond(
        Object.keys(this.workflows).map((name) => ({
          path: `.github/workflows/${name}`,
          type: "file"
        }))
      );
    }
    const content = new RegExp(`^${base}/contents/\\.github/workflows/(.+)$`).exec(route);
    if (method === "GET" && content?.[1]) {
      const source = this.workflows[decodeURIComponent(content[1])];
      if (source === undefined) throw new GitHubApiError("not found", 404);
      return respond({ encoding: "base64", content: Buffer.from(source).toString("base64") });
    }
    if (route === `${base}/rulesets` || route === "/repositories/1/rulesets") {
      if (method === "GET") {
        const page = Number(url.searchParams.get("page") ?? "1");
        const all = [...this.rulesets.values()]
          .sort((left, right) => Number(left.id) - Number(right.id))
          .map((ruleset) => ({
            id: ruleset.id,
            name: ruleset.name,
            target: ruleset.target,
            enforcement: ruleset.enforcement,
            source_type: "Repository"
          }));
        const slice = all.slice((page - 1) * this.pageSize, page * this.pageSize);
        const headers: Record<string, string> =
          page * this.pageSize < all.length
            ? {
                link: `<https://api.github.com/repositories/1/rulesets?per_page=${String(this.pageSize)}&page=${String(page + 1)}>; rel="next"`
              }
            : {};
        return respond(slice, 200, headers);
      }
      if (method === "POST") {
        const id = this.nextId++;
        let stored = { ...(body as Record<string, unknown>), id };
        if (this.storeHook) stored = { ...this.storeHook(stored), id };
        this.rulesets.set(id, this.decorate(stored));
        return respond(this.rulesets.get(id), 201);
      }
    }
    const single = new RegExp(`^${base}/rulesets/(\\d+)$`).exec(route);
    if (single?.[1]) {
      const id = Number(single[1]);
      const existing = this.rulesets.get(id);
      if (!existing) throw new GitHubApiError("not found", 404);
      if (method === "GET") return respond(existing);
      if (method === "PUT") {
        let stored = { ...(body as Record<string, unknown>), id };
        if (this.storeHook) stored = { ...this.storeHook(stored), id };
        this.rulesets.set(id, this.decorate(stored));
        return respond(this.rulesets.get(id));
      }
      if (method === "DELETE") {
        this.rulesets.delete(id);
        return respond(null, 204);
      }
    }
    throw new Error(`fake GitHub has no route for ${method} ${path}`);
  }
}

/** Creates a temporary git repository with the tracked contract and the given origin remote. */
export async function tempRepository(
  origin = "https://github.com/octo/repository.git"
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "governance-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: directory });
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: directory });
  await writeFile(join(directory, "governance-contract.json"), rawContractText());
  return directory;
}
