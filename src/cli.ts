#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PolicyError } from "./errors.js";
import { safeErrorMessage } from "./redaction.js";
import * as runtime from "./runtime.js";

const COMMANDS = ["plan", "apply", "verify", "restore"] as const;
type Command = (typeof COMMANDS)[number];

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_DRIFT = 3;

export type Runtime = Pick<typeof runtime, Command>;

function isCommand(value: string | undefined): value is Command {
  return COMMANDS.includes(value as Command);
}

function summarize(changes: { created: string[]; updated: string[]; deleted: string[] }): string {
  return `created ${String(changes.created.length)}, updated ${String(changes.updated.length)}, deleted ${String(changes.deleted.length)}`;
}

export async function main(
  argv = process.argv.slice(2),
  output: Pick<Console, "log" | "error"> = console,
  commands: Runtime = runtime
): Promise<number> {
  const command = argv[0];
  if (!isCommand(command) || argv.length !== 1) {
    output.error("usage: repository-policy <plan|apply|verify|restore>");
    return EXIT_USAGE;
  }

  try {
    if (command === "plan") {
      const result = await commands.plan();
      output.log(
        `${String(result.plan.actions.length)} managed change(s) planned for ${result.plan.repository}; wrote ${runtime.PLAN_JSON} and ${runtime.PLAN_MARKDOWN}`
      );
      for (const blocker of result.plan.blockers) output.error(`blocker: ${blocker}`);
      for (const warning of result.plan.warnings) output.log(`warning: ${warning}`);
    } else if (command === "apply") {
      const result = await commands.apply();
      output.log(
        result.plan.actions.length === 0
          ? "managed policy already matches the contract; no changes"
          : `managed policy applied and verified (${summarize(result.changes)})`
      );
      output.log(`remote write requests: ${String(result.remoteWrites)}`);
    } else if (command === "verify") {
      await commands.verify();
      output.log("managed policy matches the contract");
    } else {
      const result = await commands.restore();
      output.log(
        `managed policy restored from the recovery snapshot (${summarize(result.changes)})`
      );
    }
    return EXIT_OK;
  } catch (error) {
    output.error(safeErrorMessage(error));
    return error instanceof PolicyError && error.code === "POLICY_DRIFT"
      ? EXIT_DRIFT
      : EXIT_FAILURE;
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = await main();
}
