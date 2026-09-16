#!/usr/bin/env node
import "dotenv/config";
import { closeDashboardServer, startDashboardServer } from "./dashboard-server.js";
import { runContinuousExperiment } from "./experiment-runner.js";
import { safeErrorMessage } from "./http.js";

function integerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = (process.env[name] ?? String(fallback)).trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

async function waitForShutdown(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

async function main(): Promise<void> {
  const server = await startDashboardServer();
  const runExperiment = booleanEnv("RUN_EXPERIMENT", true);
  let experiment: Promise<void> | null = null;
  if (runExperiment) {
    const liquidationWindowMs = integerEnv("LIQUIDATION_WINDOW_MS", 3_000, 0, 30_000);
    const boundaryDelayMs = integerEnv("BOUNDARY_DELAY_MS", 10_000, 1_000, 60_000);
    experiment = runContinuousExperiment(liquidationWindowMs, boundaryDelayMs).catch((error) => {
      process.stderr.write(`Hosted experiment stopped unexpectedly: ${safeErrorMessage(error)}\n`);
    });
  }

  await waitForShutdown();
  await closeDashboardServer(server);
  if (experiment) await experiment;
}

main().catch((error) => {
  process.stderr.write(`Hosted service failed: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
