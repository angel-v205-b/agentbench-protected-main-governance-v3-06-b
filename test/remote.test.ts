import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGitHubRemote, resolveRepositoryFromOrigin } from "../src/remote.js";
import { tempRepository } from "./helpers.js";

describe("GitHub remote parsing", () => {
  it.each([
    ["https://github.com/octo/repository.git", "octo", "repository"],
    ["https://github.com/octo/repository", "octo", "repository"],
    ["git@github.com:octo/repository.git", "octo", "repository"],
    ["ssh://git@github.com/octo/repository.git", "octo", "repository"],
    ["https://github.com/octo/my.repo.git\n", "octo", "my.repo"]
  ])("resolves credential-free remote %s", (remote, owner, repository) => {
    expect(parseGitHubRemote(remote)).toEqual({ owner, repository });
  });

  it.each([
    ["https://", "token@", "github.com/octo/repository.git"].join(""),
    ["https://", "octo:secret@", "github.com/octo/repository.git"].join(""),
    "https://example.com/octo/repository.git",
    "http://github.com/octo/repository.git",
    "https://github.com/octo/repository/extra",
    "https://github.com/octo/..",
    "file:///tmp/repository"
  ])("rejects unsupported or credential-bearing remote %s", (remote) => {
    let message = "";
    try {
      parseGitHubRemote(remote);
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/not a supported credential-free GitHub remote/);
    expect(message).not.toContain("secret");
  });

  it("reads origin from a temporary repository", async () => {
    const directory = await tempRepository("https://github.com/octo-tester/target.git");
    expect(resolveRepositoryFromOrigin(directory)).toEqual({
      owner: "octo-tester",
      repository: "target"
    });
  });

  it("reports a missing origin remote", async () => {
    const directory = await mkdtemp(join(tmpdir(), "governance-noremote-"));
    execFileSync("git", ["init", "-q"], { cwd: directory });
    expect(() => resolveRepositoryFromOrigin(directory)).toThrow(/unable to resolve the origin/);
  });
});
