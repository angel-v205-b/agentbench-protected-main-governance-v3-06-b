import { describe, expect, it, vi } from "vitest";
import {
  extractWorkflowJobNames,
  FetchGitHubTransport,
  GitHubClient,
  nextPagePath,
  parseRetryAfter,
  type FetchLike
} from "../src/github.js";
import { CI_WORKFLOW, expectedRuleset, FakeGitHub, RecordingTransport } from "./helpers.js";

interface FakeResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  error?: Error;
}

function scriptedFetch(responses: FakeResponse[]) {
  const fetchImpl = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("no scripted response");
    if (next.error) throw next.error;
    return {
      status: next.status,
      headers: { entries: () => Object.entries(next.headers ?? {})[Symbol.iterator]() },
      text: async () => next.body ?? ""
    };
  });
  return fetchImpl;
}

function transportFor(responses: FakeResponse[], options = {}) {
  const fetchImpl = scriptedFetch(responses);
  const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
  const transport = new FetchGitHubTransport(
    "test-token",
    fetchImpl as unknown as FetchLike,
    "https://api.github.com",
    { sleep, now: () => Date.parse("2026-01-01T00:00:00Z"), ...options }
  );
  return { transport, fetchImpl, sleep };
}

describe("GitHub client", () => {
  it("follows ruleset pagination until the final page", async () => {
    const transport = new RecordingTransport();
    transport.queue(
      Array.from({ length: 100 }, (_, index) => ({ ...expectedRuleset(index + 1) })),
      200,
      { link: '<https://api.github.com/repositories/1/rulesets?page=2>; rel="next"' }
    );
    transport.queue([{ ...expectedRuleset(101), name: "agentbench/second" }]);
    const client = new GitHubClient("octo", "repository", transport);

    const result = await client.listRulesets();

    expect(result).toHaveLength(101);
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[1]!.path).toContain("page=2");
  });

  it("pages through a stateful API with small pages", async () => {
    const rulesets = Array.from({ length: 7 }, (_, index) => ({
      ...expectedRuleset(index + 1),
      name: `manual/r${String(index)}`
    }));
    const github = new FakeGitHub("octo", "repository", rulesets);
    github.pageSize = 3;
    const client = new GitHubClient("octo", "repository", github);
    expect(await client.listRulesets()).toHaveLength(7);
    expect(github.calls).toHaveLength(3);
  });

  it("bounds the number of pages it will follow", async () => {
    const transport = new RecordingTransport();
    const link = { Link: '<https://api.github.com/repositories/1/rulesets?page=2>; rel="next"' };
    transport.queue([], 200, link);
    transport.queue([], 200, link);
    const client = new GitHubClient("octo", "repository", transport, 2);
    await expect(client.listRulesets()).rejects.toThrow(/exceeded 2 pages/);
  });

  it("refuses pagination links to another origin", () => {
    expect(() => nextPagePath('<https://evil.example/rulesets?page=2>; rel="next"')).toThrow(
      /another origin/
    );
    expect(() => nextPagePath('<not a url>; rel="next"')).toThrow(/malformed/);
    expect(nextPagePath('<https://api.github.com/x?page=1>; rel="prev"')).toBeUndefined();
  });

  it("rejects malformed list responses", async () => {
    const transport = new RecordingTransport();
    transport.queue({ unexpected: true });
    const client = new GitHubClient("octo", "repository", transport);
    await expect(client.listRulesets()).rejects.toThrow(/malformed/i);
  });

  it("rejects malformed list items, repositories, branches and rulesets", async () => {
    const transport = new RecordingTransport();
    const client = new GitHubClient("octo", "repository", transport);
    transport.queue([{ id: "1" }]);
    await expect(client.listRulesets()).rejects.toThrow(/malformed ruleset list/);
    transport.queue({});
    await expect(client.getDefaultBranch()).rejects.toThrow(/malformed repository/);
    transport.queue({ name: "other", protected: false });
    await expect(client.getBranch("main")).rejects.toThrow(/malformed branch/);
    transport.queue({ id: 4, name: "x", target: "branch", enforcement: "maybe" });
    await expect(client.getRuleset(4)).rejects.toThrow(/malformed ruleset/);
    transport.queue({ id: 4 }, 201);
    await expect(client.createRuleset(expectedRuleset(0))).rejects.toThrow(/malformed/);
    transport.queue(null);
    await expect(client.updateRuleset(4, expectedRuleset(0))).rejects.toThrow(/malformed/);
  });

  it("sends only managed fields when creating or updating", async () => {
    const transport = new RecordingTransport();
    transport.queue(expectedRuleset(9), 201);
    const client = new GitHubClient("octo", "repository", transport);
    await client.createRuleset({ ...expectedRuleset(0), node_id: "x" } as never);
    expect(Object.keys(transport.calls[0]!.body as object).sort()).toEqual([
      "bypass_actors",
      "conditions",
      "enforcement",
      "name",
      "rules",
      "target"
    ]);
  });

  it("uses only the minimum body when deleting a ruleset", async () => {
    const transport = new RecordingTransport();
    transport.queue(null, 204);
    const client = new GitHubClient("octo", "repository", transport);
    await client.deleteRuleset(72);
    expect(transport.calls).toEqual([
      { method: "DELETE", path: "/repos/octo/repository/rulesets/72" }
    ]);
  });

  it("reads configured workflow job names from the default branch", async () => {
    const github = new FakeGitHub();
    github.workflows["notes.txt"] = "ignored";
    const client = new GitHubClient("octo", "repository", github);
    expect(await client.listWorkflowCheckNames("main")).toEqual(["CI / package", "CI / test"]);
  });

  it("treats a missing workflow directory as no configured checks", async () => {
    const transport = new RecordingTransport();
    transport.queue(null, 404);
    const client = new GitHubClient("octo", "repository", transport);
    expect(await client.listWorkflowCheckNames("main")).toEqual([]);
    transport.queue(null, 500);
    await expect(client.listWorkflowCheckNames("main")).rejects.toThrow(/failed/);
  });

  it("rejects malformed workflow listings and files", async () => {
    const transport = new RecordingTransport();
    const client = new GitHubClient("octo", "repository", transport);
    transport.queue({});
    await expect(client.listWorkflowCheckNames("main")).rejects.toThrow(/malformed workflow/);
    transport.queue([{ path: 1 }]);
    await expect(client.listWorkflowCheckNames("main")).rejects.toThrow(/malformed workflow/);
    transport.queue([{ path: ".github/workflows/ci.yml", type: "file" }]);
    transport.queue({ content: "x", encoding: "utf8" });
    await expect(client.listWorkflowCheckNames("main")).rejects.toThrow(/malformed workflow file/);
  });
});

describe("workflow job name extraction", () => {
  it("uses job names, falls back to job ids and skips dynamic names", () => {
    const source = [
      "name: Other",
      "jobs:",
      "  # comment",
      "  lint:",
      "    runs-on: ubuntu-latest",
      "  build:",
      "    name: 'Build ${{ matrix.os }}'",
      "  deploy:",
      "    name: Deploy # trailing comment",
      "    steps:",
      "      - name: nested",
      "env:",
      "  name: not-a-job"
    ].join("\n");
    expect(extractWorkflowJobNames(source)).toEqual(["lint", "Deploy"]);
    expect(extractWorkflowJobNames(CI_WORKFLOW)).toEqual(["CI / test", "CI / package"]);
    expect(extractWorkflowJobNames("name: none\n")).toEqual([]);
  });
});

describe("GitHub HTTP transport", () => {
  it("honors Retry-After for transient rate limits and then succeeds", async () => {
    const { transport, fetchImpl, sleep } = transportFor([
      { status: 429, headers: { "retry-after": "0" }, body: "rate limited" },
      { status: 200, body: '{"ok":true}' }
    ]);
    await expect(transport.request("GET", "/test")).resolves.toMatchObject({
      status: 200,
      body: { ok: true }
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(0);
  });

  it("sends authentication only in headers and never in the URL", async () => {
    const { transport, fetchImpl } = transportFor([{ status: 204 }]);
    await transport.request("DELETE", "/x");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> }
    ];
    expect(url).toBe("https://api.github.com/x");
    expect(init.headers.Authorization).toBe("Bearer test-token");
  });

  it("uses an HTTP-date Retry-After and secondary rate limits", async () => {
    const { transport, sleep } = transportFor([
      { status: 403, headers: { "retry-after": "Thu, 01 Jan 2026 00:00:05 GMT" }, body: "{}" },
      { status: 200, body: "[]" }
    ]);
    await transport.request("GET", "/test");
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it("waits for the primary rate-limit reset when no Retry-After is given", async () => {
    const reset = String(Date.parse("2026-01-01T00:00:03Z") / 1000);
    const { transport, sleep } = transportFor([
      { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } },
      { status: 200, body: "{}" }
    ]);
    await transport.request("GET", "/test");
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("falls back to bounded backoff for invalid Retry-After values", async () => {
    const { transport, sleep } = transportFor([
      { status: 429, headers: { "retry-after": "-5" } },
      { status: 503 },
      { status: 200, body: "{}" }
    ]);
    await transport.request("GET", "/test");
    expect(sleep.mock.calls).toEqual([[500], [1000]]);
  });

  it("gives up instead of sleeping past the maximum retry delay", async () => {
    const { transport, sleep } = transportFor([
      { status: 429, headers: { "retry-after": "3600" }, body: '{"message":"slow down"}' }
    ]);
    await expect(transport.request("GET", "/test")).rejects.toThrow(/rate limited \(429\)/);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("bounds retries of transient failures", async () => {
    const { transport, fetchImpl } = transportFor(
      Array.from({ length: 5 }, () => ({ status: 502 })),
      { maxAttempts: 3 }
    );
    await expect(transport.request("GET", "/test")).rejects.toThrow(/\(502\) after 3 attempt/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403, 404, 422])("does not retry permanent failure %i", async (status) => {
    const { transport, fetchImpl } = transportFor([
      { status, body: '{"message":"no"}' },
      { status: 200, body: "{}" }
    ]);
    await expect(transport.request("PUT", "/test", {})).rejects.toMatchObject({ status });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry non-idempotent POST requests after server errors", async () => {
    const { transport, fetchImpl } = transportFor([{ status: 502 }, { status: 201, body: "{}" }]);
    await expect(transport.request("POST", "/test", {})).rejects.toThrow(/502/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries POST when GitHub rate limited it before processing", async () => {
    const { transport, fetchImpl } = transportFor([
      { status: 429, headers: { "retry-after": "1" } },
      { status: 201, body: '{"id":1}' }
    ]);
    await expect(transport.request("POST", "/test", {})).resolves.toMatchObject({ status: 201 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries network errors and timeouts for idempotent requests only", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const network = new TypeError("fetch failed");
    const first = transportFor([
      { status: 0, error: network },
      { status: 200, body: "{}" }
    ]);
    await expect(first.transport.request("GET", "/test")).resolves.toMatchObject({ status: 200 });

    const second = transportFor([{ status: 0, error: timeout }]);
    await expect(second.transport.request("POST", "/test", {})).rejects.toThrow(
      /request timed out after 1 attempt/
    );

    const third = transportFor([{ status: 0, error: network }], { maxAttempts: 1 });
    await expect(third.transport.request("GET", "/test")).rejects.toThrow(/network error/);
  });

  it("rejects malformed JSON in successful responses", async () => {
    const { transport } = transportFor([{ status: 200, body: "<html>" }]);
    await expect(transport.request("GET", "/test")).rejects.toThrow(/malformed JSON/);
  });

  it("returns null for empty successful responses", async () => {
    const { transport } = transportFor([{ status: 204, body: "" }]);
    await expect(transport.request("DELETE", "/test")).resolves.toMatchObject({ body: null });
  });

  it("rejects empty tokens and absolute request URLs", async () => {
    expect(() => new FetchGitHubTransport("  ")).toThrow(/empty/);
    const { transport } = transportFor([]);
    await expect(transport.request("GET", "https://evil.example/x")).rejects.toThrow(/relative/);
  });

  it("redacts secret-like fields from remote errors", async () => {
    const fakeToken = ["ghp", "supersecret123"].join("_");
    const fakeFetch = vi.fn(async () => ({
      status: 400,
      headers: { entries: () => [][Symbol.iterator]() },
      text: async () => JSON.stringify({ token: fakeToken, message: "bad credentials" })
    })) as unknown as FetchLike;
    const transport = new FetchGitHubTransport("test-token", fakeFetch);
    let message = "";
    try {
      await transport.request("GET", "/test");
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain("supersecret123");
    expect(message).toContain("REDACTED");
  });

  it("never echoes its own token in errors", async () => {
    const secret = ["github", "pat", "11AAAAA", "zzzzzzzzzz"].join("_");
    const echo = vi.fn(async () => ({
      status: 500,
      headers: { entries: () => [][Symbol.iterator]() },
      text: async () => `upstream said Authorization: Bearer ${secret}`
    })) as unknown as FetchLike;
    const leaky = new FetchGitHubTransport(secret, echo, "https://api.github.com", {
      maxAttempts: 1
    });
    await expect(leaky.request("GET", "/x")).rejects.toThrow(/Bearer \[REDACTED\]/);
    await expect(leaky.request("GET", "/x")).rejects.not.toThrow(/zzzzzzzzzz/);
  });
});

describe("Retry-After parsing", () => {
  it.each([
    [undefined, undefined],
    ["7", 7000],
    ["abc", undefined],
    ["1.5", undefined],
    ["Thu, 01 Jan 2026 00:00:10 GMT", 10_000],
    ["Wed, 31 Dec 2025 00:00:00 GMT", 0],
    ["Not a date at all", undefined]
  ])("parses %j", (value, expected) => {
    expect(parseRetryAfter(value, Date.parse("2026-01-01T00:00:00Z"))).toBe(expected);
  });
});
