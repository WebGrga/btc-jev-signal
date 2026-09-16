import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ExperimentReport,
  PredictionBatch,
  Settlement,
} from "./experiment-types.js";

export interface ExperimentPaths {
  directory: string;
  predictions: string;
  settlements: string;
  reportJson: string;
  reportMarkdown: string;
}

export function experimentPaths(): ExperimentPaths {
  const directory = path.resolve(process.env.EXPERIMENT_DATA_DIR ?? "data");
  return {
    directory,
    predictions: path.join(directory, "predictions.jsonl"),
    settlements: path.join(directory, "settlements.jsonl"),
    reportJson: path.join(directory, "report.json"),
    reportMarkdown: path.join(directory, "report.md"),
  };
}

export async function ensureExperimentDirectory(paths = experimentPaths()): Promise<void> {
  await mkdir(paths.directory, { recursive: true });
}

async function loadJsonLines<T>(filePath: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const values: T[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line) as T);
    } catch {
      throw new Error(`Invalid JSON in ${filePath} at line ${index + 1}`);
    }
  }
  return values;
}

export async function loadBatches(paths = experimentPaths()): Promise<PredictionBatch[]> {
  return loadJsonLines<PredictionBatch>(paths.predictions);
}

export async function loadSettlements(paths = experimentPaths()): Promise<Settlement[]> {
  return loadJsonLines<Settlement>(paths.settlements);
}

export async function appendBatch(
  batch: PredictionBatch,
  paths = experimentPaths(),
): Promise<void> {
  await ensureExperimentDirectory(paths);
  await appendFile(paths.predictions, `${JSON.stringify(batch)}\n`, "utf8");
}

export async function appendSettlement(
  settlement: Settlement,
  paths = experimentPaths(),
): Promise<void> {
  await ensureExperimentDirectory(paths);
  await appendFile(paths.settlements, `${JSON.stringify(settlement)}\n`, "utf8");
}

export async function saveReport(
  report: ExperimentReport,
  markdown: string,
  paths = experimentPaths(),
): Promise<void> {
  await ensureExperimentDirectory(paths);
  await Promise.all([
    writeFile(paths.reportJson, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(paths.reportMarkdown, markdown, "utf8"),
  ]);
}
