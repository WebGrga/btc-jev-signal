#!/usr/bin/env node
import "dotenv/config";
import { buildExperimentState } from "./experiment-market.js";
import { safeErrorMessage } from "./http.js";
import {
  runContinuousExperiment,
  runOneExperimentCycle,
  settleDueForecasts,
  writeCurrentReport,
} from "./experiment-runner.js";
import { experimentPaths, loadBatches, loadSettlements } from "./experiment-store.js";
import { buildReport, reportMarkdown } from "./experiment-report.js";

function integerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

async function printReport(): Promise<void> {
  await writeCurrentReport();
  const paths = experimentPaths();
  const [batches, settlements] = await Promise.all([loadBatches(paths), loadSettlements(paths)]);
  process.stdout.write(reportMarkdown(buildReport(batches, settlements)));
  process.stderr.write(`Report files: ${paths.reportMarkdown} and ${paths.reportJson}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "run";
  const liquidationWindowMs = integerEnv("LIQUIDATION_WINDOW_MS", 3_000, 0, 30_000);
  const boundaryDelayMs = integerEnv("BOUNDARY_DELAY_MS", 10_000, 1_000, 60_000);

  if (command === "run") {
    await runContinuousExperiment(liquidationWindowMs, boundaryDelayMs);
    return;
  }
  if (command === "once") {
    await runOneExperimentCycle(liquidationWindowMs);
    return;
  }
  if (command === "state") {
    const boundaryMs = Math.floor(Date.now() / 60_000) * 60_000;
    const state = await buildExperimentState(boundaryMs, "manual_once", liquidationWindowMs);
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return;
  }
  if (command === "settle") {
    const count = await settleDueForecasts();
    process.stdout.write(`Settled ${count} forecast(s).\n`);
    return;
  }
  if (command === "report") {
    await printReport();
    return;
  }
  throw new Error("Usage: experiment-cli run | once | state | settle | report");
}

main().catch((error) => {
  process.stderr.write(`btc-jev experiment failed: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
