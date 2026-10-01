# Protected Main Governance Rollout

A typed Node.js CLI that reconciles a narrowly owned set of GitHub repository rulesets with
`governance-contract.json`, verifies the live policy against the contract, and can restore the
managed rulesets from a validated local recovery snapshot.

## Requirements

- Node.js 22
- npm 10 or newer
- Git 2.40 or newer
- a credential-free `origin` remote: `https://github.com/OWNER/REPO.git`,
  `git@github.com:OWNER/REPO.git` or `ssh://git@github.com/OWNER/REPO.git`

Install dependencies with `npm ci`. The CLI has no runtime dependencies; development dependencies
are pinned exactly in `package.json` and `package-lock.json`.

## Governance model

`governance-contract.json` is the source of truth. It is validated strictly before any request is
made. Validation rejects:

- unsupported `version` values and unknown keys at any level;
- unsupported rule types (any key under `rules` other than the eight documented ones) and missing
  rules (every rule is stated explicitly);
- duplicate managed ruleset names, rulesets outside `managedNamePrefix`, and prefixes that are not a
  literal namespace ending in `/`;
- malformed branch selectors (anything other than `~DEFAULT_BRANCH` or a valid `refs/heads/...`
  name) and unsafe wildcards such as `refs/heads/*`, `refs/heads/**` or `~ALL` — wildcards need a
  literal leading segment, e.g. `refs/heads/release/*`;
- empty, padded or duplicate status-check names;
- conflicting policies: review requirements without `requirePullRequest`, `strictStatusChecks`
  without checks, linear history with `mergeMethod: "merge"`, or two managed rulesets claiming the
  same branch selector;
- malformed bypass actors. A ruleset has no bypass actor unless one is listed explicitly.

The tracked contract defines `agentbench/protected-main`, which targets the repository's actual
default branch (read from GitHub, not assumed) and:

| Contract rule                       | GitHub ruleset rule                                   |
| ----------------------------------- | ----------------------------------------------------- |
| `requirePullRequest`, `mergeMethod` | `pull_request` with `allowed_merge_methods: [squash]` |
| `requireResolvedConversations`      | `pull_request.required_review_thread_resolution`      |
| `requireStatusChecks`               | `required_status_checks`: `CI / test`, `CI / package` |
| `strictStatusChecks`                | `strict_required_status_checks_policy` (head current) |
| `requireLinearHistory`              | `required_linear_history`                             |
| `blockForcePushes`                  | `non_fast_forward`                                    |
| `blockDeletions`                    | `deletion`                                            |

## Managed scope

The contract owns only repository rulesets whose names begin with `managedNamePrefix`
(`agentbench/`). Everything else is out of scope and is never written: repository visibility,
collaborators, organization membership, Actions permissions, secrets, variables, environments,
webhooks, deploy keys, issue settings, classic branch protection, and unmanaged rulesets.
Organization-level rulesets are not listed (`includes_parents=false`). The only write endpoints the
CLI calls are `POST`, `PUT` and `DELETE` on `/repos/OWNER/REPO/rulesets[/ID]`, and `PUT`/`DELETE`
only target IDs of managed rulesets observed during the same run.

## Commands

```text
npm run policy -- plan
npm run policy -- apply
npm run policy -- verify
npm run policy -- restore
```

The target repository is resolved from `git remote get-url origin`. Remotes containing any user
information (a user name or password before `@github.com`) are rejected without echoing them.

- **`plan`** is read-only (its transport refuses non-`GET` requests). It reads the default branch,
  the default branch's state (including whether classic protection is present), every repository
  ruleset, and the job names of workflows on the default branch. It computes the minimum managed
  changes and writes `artifacts/governance-plan.json` and `artifacts/governance-plan.md`. Output
  is deterministic: stable key ordering, sorted lists, no timestamps, request IDs, local paths,
  tokens or remote error bodies; repeated runs against unchanged state are byte-identical.
  The plan lists **blockers** (a required status check that no workflow job on the default branch
  produces — requiring it would make every pull request unmergeable) and **warnings** (contract
  default branch differs from the live one; classic protection present).
- **`apply`** rebuilds the plan from live state and refuses to run if it has blockers. With no
  changes it sends no write and writes no snapshot. Otherwise it:

  1. writes the recovery snapshot of the managed pre-change rulesets (before any remote write);
  2. creates or updates each contract ruleset and independently re-reads it, failing unless the
     live ruleset matches the contract;
  3. only after every replacement is verified, deletes obsolete or duplicate managed rulesets;
  4. re-reads live state and fails if it still differs from the contract.

  If step 2 fails, changes made so far are rolled back (created rulesets removed, updated rulesets
  returned to their recorded bodies) so the last verified managed policy stays in force and nothing
  obsolete has been deleted. If step 3 fails, the verified replacement remains active and re-running
  `apply` finishes the deletions. `apply` prints the number of remote write requests it sent.

- **`verify`** is read-only and exits `3` when live policy differs from the contract (listing the
  required changes) or the plan has blockers.
- **`restore`** validates the recovery snapshot before reading a credential or contacting GitHub,
  then restores only the contract-managed rulesets recorded in it (see below).

Exit codes: `0` success, `1` failure, `2` usage error, `3` policy drift.

### Comparison rules

Live rulesets are compared on the managed fields only: name, target, enforcement, `ref_name`
conditions, bypass actors, the set of rule types, and every rule parameter the tool states
explicitly (all parameters it sends, including ones set to `false`). Metadata such as node IDs,
links and timestamps is ignored, array order is ignored, and a parameter reported at its default
value (`false`, `0`, `null`, empty) equals an omitted one. Parameters GitHub adds on its own that
the tool does not send (for example newer API defaults such as
`require_extra_approval_for_unattributed_changes`) are outside the managed fields and are not drift.
Any other difference — an extra or missing rule, a changed stated parameter, or a bypass actor not
listed in the contract — is drift that `apply` corrects with an in-place update, and drift output
names the differing parameters.

## Idempotency guarantees

- `plan` and `verify` never write.
- Re-running `apply` after success sends zero write requests and creates no duplicate ruleset.
- If duplicates of a managed name exist (for example after an interrupted earlier tool), `apply`
  keeps one compliant ruleset (or updates the oldest) and deletes the rest after verification.
- Creates are never retried automatically after an ambiguous server error; the next run reads live
  state and reconciles whatever actually exists.

## Recovery procedure

`apply` writes `artifacts/recovery-snapshot.json` (mode `0600`, ignored by Git) immediately before
its first remote write. It contains only the repository name, default branch, managed prefix and the
managed rulesets' managed fields — no credentials, headers, local paths or response metadata.
An existing snapshot is never overwritten: archive it before the next rollout that needs changes.

To recover:

1. Run `npm run policy -- verify` to see the current difference from the contract.
2. Run `npm run policy -- restore`. It rejects missing, unparsable or structurally invalid
   snapshots, unknown keys (which could widen restore scope), rulesets outside the managed prefix,
   and snapshots taken for a different repository or prefix.
3. Restore recreates or updates (and verifies) each recorded ruleset first; managed rulesets that
   are not in the snapshot are deleted only after all of those writes succeed. If any write fails,
   nothing is deleted and the error reports what was already restored. Unmanaged rulesets and
   repository settings are never touched.
4. Move the consumed snapshot aside before the next `apply`.

## Credential handling

The CLI reads a token at runtime from `GITHUB_TOKEN_FILE`, defaulting to
`~/.config/agent-eval/github-governance-token.txt`, and trims surrounding whitespace. The token is
sent only in the `Authorization` header to `https://api.github.com`; it is never placed in URLs,
command-line arguments, Git remotes, artifacts, snapshots or logs. Pagination links to any other
origin are refused. Error messages are redacted (bearer/basic credentials, GitHub token formats,
credential URLs, `token=` query values, sensitive JSON keys), and remote error bodies are reduced to
a bounded, redacted summary. Artifacts and snapshots are checked for credential-like material before
they are written.

## Expected GitHub permissions

A fine-grained token scoped to the target repository with:

- **Administration: read and write** — read and write repository rulesets (`plan`/`verify` need
  read only);
- **Contents: read** — read workflow files on the default branch;
- **Metadata: read** — repository and branch information.

## HTTP behavior

Requests time out after 30 seconds. Transient failures (network errors, timeouts, 500/502/503/504)
are retried for idempotent methods with exponential backoff; rate limits (429, or 403 with
`x-ratelimit-remaining: 0`, `Retry-After` or a secondary-rate-limit message) are retried for every
method, honoring a valid `Retry-After` (seconds or HTTP date) or the rate-limit reset time. At most
four attempts are made, and a single wait longer than 60 seconds fails instead of sleeping.
Authorization and validation failures (401, 403, 404, 422, …) are never retried. Paginated
listings follow `Link: rel="next"` up to 20 pages, and malformed responses are rejected.

## Limitations

- Only `branch` rulesets are managed, and only the eight contract rule types are supported.
- Workflow job names are read with a small line-based reader for block-style YAML; names built from
  expressions (`${{ }}`) or matrix jobs cannot be resolved and are reported as missing.
- Classic branch protection is reported but not managed.
- GitHub has no transactions: a crash between steps can leave a partial state. The snapshot plus
  re-running `apply` (or `restore`) recovers it.
- `allowed_merge_methods` requires a GitHub API version that supports the ruleset merge-method
  parameter (GitHub.com does).

## Development

```text
npm run format:check
npm run lint
npm run typecheck     # sources and tests, strict
npm test
npm run coverage      # thresholds: 90% statements/functions/lines, 85% branches
npm run package:check
npm run verify        # format, lint, typecheck and coverage
```

Tests use an in-memory fake of the GitHub REST API and temporary Git repositories. They never read
the live token or contact GitHub.
