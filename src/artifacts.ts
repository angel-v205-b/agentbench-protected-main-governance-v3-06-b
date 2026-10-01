import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PolicyError } from "./errors.js";
import { redactSensitive } from "./redaction.js";
import { stableJson } from "./stable-json.js";
import type { GovernancePlan, PlanAction } from "./types.js";

function code(value: string): string {
  return `\`${value.replace(/`/g, "'")}\``;
}

function describeAction(action: PlanAction): string {
  switch (action.kind) {
    case "create":
      return `- create ${code(action.name)} targeting ${action.desired.conditions.ref_name.include
        .map(code)
        .join(", ")}`;
    case "update":
      return `- update ${code(action.name)} (ruleset ${String(action.rulesetId)}): ${action.changes.join(", ")}`;
    case "delete":
      return `- delete ${action.reason} ${code(action.name)} (ruleset ${String(action.rulesetId)}) after replacements are verified`;
  }
}

function list(lines: string[], items: string[], empty: string, render = code): void {
  if (items.length === 0) lines.push(empty);
  else for (const item of items) lines.push(`- ${render(item)}`);
}

export function planMarkdown(plan: GovernancePlan): string {
  const lines = [
    "# Governance plan",
    "",
    `Repository: ${code(plan.repository)}`,
    `Default branch: ${code(plan.defaultBranch)}`,
    `Managed name prefix: ${code(plan.managedNamePrefix)}`,
    `Classic branch protection on default branch: ${plan.defaultBranchClassicProtection ? "yes" : "no"}`,
    "",
    "## Managed changes",
    ""
  ];
  if (plan.actions.length === 0) lines.push("No changes required.");
  else for (const action of plan.actions) lines.push(describeAction(action));
  lines.push("", "## Required status checks", "");
  list(lines, plan.requiredStatusChecks, "None required.");
  lines.push("", "## Workflow checks configured on the default branch", "");
  list(lines, plan.configuredWorkflowChecks, "None found.");
  lines.push("", "## Blockers", "");
  list(lines, plan.blockers, "None.", (item) => item);
  lines.push("", "## Warnings", "");
  list(lines, plan.warnings, "None.", (item) => item);
  lines.push("", "## Preserved unmanaged rulesets", "");
  list(lines, plan.preservedUnmanagedRulesets, "None observed.");
  return `${lines.join("\n")}\n`;
}

export async function writePlanArtifacts(
  plan: GovernancePlan,
  jsonPath = "artifacts/governance-plan.json",
  markdownPath = "artifacts/governance-plan.md"
): Promise<void> {
  const json = stableJson(plan);
  const markdown = planMarkdown(plan);
  if (redactSensitive(json) !== json || redactSensitive(markdown) !== markdown) {
    throw new PolicyError(
      "refusing to write plan artifacts containing credential-like material",
      "ARTIFACT_UNSAFE"
    );
  }
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await Promise.all([
    writeFile(jsonPath, json, { encoding: "utf8", mode: 0o600 }),
    writeFile(markdownPath, markdown, { encoding: "utf8", mode: 0o600 })
  ]);
}
