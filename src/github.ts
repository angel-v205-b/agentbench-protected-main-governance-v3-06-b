import { GitHubApiError, PolicyError } from "./errors.js";
import { parseRulesetResponse, rulesetBody } from "./normalize.js";
import { describeRemoteBody } from "./redaction.js";
import type {
  GitHubRuleset,
  GitHubTransport,
  RulesetBody,
  RulesetSummary,
  TransportResponse
} from "./types.js";

export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{
  status: number;
  headers: { entries(): IterableIterator<[string, string]> };
  text(): Promise<string>;
}>;

export interface TransportOptions {
  /** Total attempts per request, including the first. */
  maxAttempts?: number;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Longest single wait the transport will accept before giving up instead of sleeping. */
  maxRetryDelayMs?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_API_BASE = "https://api.github.com";
const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** Parses a Retry-After header (delta-seconds or HTTP-date). Invalid values return undefined. */
export function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  if (!/[A-Za-z]/.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

export class FetchGitHubTransport implements GitHubTransport {
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  public constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch as FetchLike,
    private readonly apiBase = DEFAULT_API_BASE,
    options: TransportOptions = {}
  ) {
    if (token.trim() === "") {
      throw new PolicyError("GitHub token is empty", "EMPTY_TOKEN");
    }
    this.maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 4, 10));
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  public async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<TransportResponse<T>> {
    if (!path.startsWith("/")) {
      throw new PolicyError("GitHub request paths must be relative to the API base", "BAD_PATH");
    }
    // POST is not idempotent: only retry it when GitHub rejected it before processing (rate limits).
    const idempotent = method !== "POST";
    for (let attempt = 1; ; attempt += 1) {
      const canRetry = attempt < this.maxAttempts;
      let response: Awaited<ReturnType<FetchLike>>;
      let raw: string;
      try {
        response = await this.fetchImpl(`${this.apiBase}${path}`, {
          method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "protected-main-governance-rollout"
          },
          signal: AbortSignal.timeout(this.timeoutMs),
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        raw = await response.text();
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        if (canRetry && idempotent) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw new GitHubApiError(
          `GitHub ${method} ${path} failed: ${timedOut ? "request timed out" : "network error"} after ${String(attempt)} attempt(s)`,
          0
        );
      }

      const headers = Object.fromEntries(
        [...response.headers.entries()].map(([key, value]) => [key.toLowerCase(), value])
      );
      if (response.status >= 200 && response.status < 300) {
        let parsed: unknown = null;
        if (raw.trim() !== "") {
          try {
            parsed = JSON.parse(raw);
          } catch {
            throw new GitHubApiError(
              `GitHub ${method} ${path} returned a malformed JSON response`,
              response.status
            );
          }
        }
        return { status: response.status, headers, body: parsed as T };
      }

      const retryAfter = parseRetryAfter(headers["retry-after"], this.now());
      const remaining = headers["x-ratelimit-remaining"];
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 &&
          (remaining === "0" || retryAfter !== undefined || /secondary rate limit/i.test(raw)));
      const transient = TRANSIENT_STATUSES.has(response.status) && idempotent;
      if ((rateLimited || transient) && canRetry) {
        let delay = retryAfter;
        if (delay === undefined && rateLimited && remaining === "0") {
          const reset = Number(headers["x-ratelimit-reset"]);
          if (Number.isFinite(reset) && reset > 0) delay = Math.max(0, reset * 1000 - this.now());
        }
        delay ??= this.backoff(attempt);
        if (delay <= this.maxRetryDelayMs) {
          await this.sleep(delay);
          continue;
        }
      }
      const kind = rateLimited ? "rate limited" : "failed";
      throw new GitHubApiError(
        `GitHub ${method} ${path} ${kind} (${String(response.status)}) after ${String(attempt)} attempt(s): ${describeRemoteBody(raw)}`,
        response.status
      );
    }
  }

  private backoff(attempt: number): number {
    return Math.min(this.baseDelayMs * 2 ** (attempt - 1), this.maxRetryDelayMs);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(what: string): GitHubApiError {
  return new GitHubApiError(`GitHub returned a malformed ${what} response`, 502);
}

/** Returns the API path of a rel="next" Link, refusing to follow links to any other origin. */
export function nextPagePath(link: string | undefined): string | undefined {
  if (link === undefined) return undefined;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (!match?.[1]) continue;
    let url: URL;
    try {
      url = new URL(match[1]);
    } catch {
      throw malformed("pagination link");
    }
    if (url.protocol !== "https:" || url.host !== "api.github.com") {
      throw new PolicyError("refusing to follow a pagination link to another origin", "BAD_LINK");
    }
    return `${url.pathname}${url.search}`;
  }
  return undefined;
}

export interface BranchState {
  name: string;
  protected: boolean;
}

export class GitHubClient {
  public constructor(
    private readonly owner: string,
    private readonly repository: string,
    private readonly transport: GitHubTransport,
    private readonly maxPages = 20
  ) {}

  public get fullName(): string {
    return `${this.owner}/${this.repository}`;
  }

  private get base(): string {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repository)}`;
  }

  public async getDefaultBranch(): Promise<string> {
    const response = await this.transport.request<unknown>("GET", this.base);
    if (!isRecord(response.body) || typeof response.body.default_branch !== "string") {
      throw malformed("repository");
    }
    return response.body.default_branch;
  }

  public async getBranch(name: string): Promise<BranchState> {
    const response = await this.transport.request<unknown>(
      "GET",
      `${this.base}/branches/${encodeURIComponent(name)}`
    );
    const body = response.body;
    if (!isRecord(body) || body.name !== name || typeof body.protected !== "boolean") {
      throw malformed("branch");
    }
    return { name, protected: body.protected };
  }

  private async paginate(firstPath: string, what: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let path: string | undefined = firstPath;
    for (let page = 1; path !== undefined; page += 1) {
      if (page > this.maxPages) {
        throw new PolicyError(
          `${what} listing exceeded ${String(this.maxPages)} pages`,
          "TOO_MANY_PAGES"
        );
      }
      const response: TransportResponse<unknown> = await this.transport.request<unknown>(
        "GET",
        path
      );
      if (!Array.isArray(response.body)) throw malformed(what);
      items.push(...(response.body as unknown[]));
      path = nextPagePath(header(response.headers, "link"));
    }
    return items;
  }

  public async listRulesets(): Promise<RulesetSummary[]> {
    const items = await this.paginate(
      `${this.base}/rulesets?includes_parents=false&per_page=100`,
      "ruleset list"
    );
    return items.map((item) => {
      if (!isRecord(item) || typeof item.id !== "number" || typeof item.name !== "string") {
        throw malformed("ruleset list");
      }
      return { id: item.id, name: item.name };
    });
  }

  public async getRuleset(id: number): Promise<GitHubRuleset> {
    const response = await this.transport.request<unknown>(
      "GET",
      `${this.base}/rulesets/${String(id)}`
    );
    const ruleset = parseRulesetResponse(response.body);
    if (!ruleset) throw malformed("ruleset");
    return ruleset;
  }

  /**
   * Returns the check names produced by workflow jobs on the given ref. Job names that depend on
   * expressions cannot be resolved statically and are skipped.
   */
  public async listWorkflowCheckNames(ref: string): Promise<string[]> {
    let listing: TransportResponse<unknown>;
    try {
      listing = await this.transport.request<unknown>(
        "GET",
        `${this.base}/contents/.github/workflows?ref=${encodeURIComponent(ref)}`
      );
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return [];
      throw error;
    }
    if (!Array.isArray(listing.body)) throw malformed("workflow directory");
    const files = (listing.body as unknown[])
      .map((entry) => {
        if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.type !== "string") {
          throw malformed("workflow directory");
        }
        return { path: entry.path, type: entry.type };
      })
      .filter((entry) => entry.type === "file" && /\.ya?ml$/.test(entry.path))
      .map((entry) => entry.path)
      .sort();
    const names = new Set<string>();
    for (const path of files) {
      const response = await this.transport.request<unknown>(
        "GET",
        `${this.base}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`
      );
      const body = response.body;
      if (!isRecord(body) || typeof body.content !== "string" || body.encoding !== "base64") {
        throw malformed("workflow file");
      }
      const source = Buffer.from(body.content, "base64").toString("utf8");
      for (const name of extractWorkflowJobNames(source)) names.add(name);
    }
    return [...names].sort();
  }

  public async createRuleset(desired: RulesetBody): Promise<GitHubRuleset> {
    const response = await this.transport.request<unknown>(
      "POST",
      `${this.base}/rulesets`,
      rulesetBody(desired)
    );
    const created = parseRulesetResponse(response.body);
    if (!created) throw malformed("ruleset creation");
    return created;
  }

  public async updateRuleset(id: number, desired: RulesetBody): Promise<GitHubRuleset> {
    const response = await this.transport.request<unknown>(
      "PUT",
      `${this.base}/rulesets/${String(id)}`,
      rulesetBody(desired)
    );
    const updated = parseRulesetResponse(response.body);
    if (!updated) throw malformed("ruleset update");
    return updated;
  }

  public async deleteRuleset(id: number): Promise<void> {
    await this.transport.request("DELETE", `${this.base}/rulesets/${String(id)}`);
  }
}

function unquote(value: string): string {
  const withoutComment = value.replace(/\s+#.*$/, "").trim();
  const quoted = /^(["'])(.*)\1$/.exec(withoutComment);
  return quoted?.[2] ?? withoutComment;
}

/**
 * Extracts job check names from a workflow file without a YAML dependency. It understands the
 * block-style layout used by GitHub workflows: a top-level `jobs:` mapping whose children are job
 * ids, each optionally carrying a `name:` at the job's property indentation.
 */
export function extractWorkflowJobNames(source: string): string[] {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => /^jobs:\s*(#.*)?$/.test(line));
  if (start === -1) return [];
  const names: string[] = [];
  let jobIndent: number | undefined;
  let current: { id: string; name?: string; propertyIndent?: number } | undefined;
  const finish = (): void => {
    if (current) {
      const name = current.name ?? current.id;
      if (!name.includes("${{")) names.push(name);
    }
  };
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break;
    jobIndent ??= indent;
    if (indent === jobIndent) {
      const job = /^\s+([A-Za-z_][A-Za-z0-9_-]*):\s*(#.*)?$/.exec(line);
      finish();
      current = job?.[1] ? { id: job[1] } : undefined;
      continue;
    }
    if (!current || indent < jobIndent) continue;
    current.propertyIndent ??= indent;
    if (indent !== current.propertyIndent) continue;
    const name = /^\s+name:\s*(.+)$/.exec(line);
    if (name?.[1]) current.name = unquote(name[1]);
  }
  finish();
  return names;
}
