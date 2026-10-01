import { execFileSync } from "node:child_process";
import { PolicyError } from "./errors.js";

export interface RepositoryCoordinates {
  owner: string;
  repository: string;
}

const OWNER = "([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))";
const REPOSITORY = "([A-Za-z0-9._-]{1,100}?)";
const REMOTE_FORMS = [
  new RegExp(`^https://github\\.com/${OWNER}/${REPOSITORY}(?:\\.git)?/?$`),
  new RegExp(`^git@github\\.com:${OWNER}/${REPOSITORY}(?:\\.git)?$`),
  new RegExp(`^ssh://git@github\\.com(?::22)?/${OWNER}/${REPOSITORY}(?:\\.git)?$`)
];

/**
 * Resolves owner and repository from a credential-free GitHub remote. HTTPS remotes carrying any
 * user information are rejected, and the remote itself is never echoed in the error because it
 * may contain credentials.
 */
export function parseGitHubRemote(remote: string): RepositoryCoordinates {
  const value = remote.trim();
  for (const form of REMOTE_FORMS) {
    const match = form.exec(value);
    const owner = match?.[1];
    const repository = match?.[2];
    if (owner && repository && repository !== "." && repository !== "..") {
      return { owner, repository };
    }
  }
  throw new PolicyError(
    "origin is not a supported credential-free GitHub remote (expected https://github.com/OWNER/REPO.git or an SSH form)",
    "INVALID_REMOTE"
  );
}

export function resolveRepositoryFromOrigin(cwd = process.cwd()): RepositoryCoordinates {
  let origin: string;
  try {
    origin = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    throw new PolicyError("unable to resolve the origin remote", "MISSING_REMOTE");
  }
  return parseGitHubRemote(origin);
}
