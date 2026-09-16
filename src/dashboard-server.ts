import express, { type Express } from "express";
import { access } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { buildDashboardData } from "./dashboard-data.js";
import { experimentPaths, loadBatches, loadSettlements } from "./experiment-store.js";
import { safeErrorMessage } from "./http.js";

export interface DashboardServerOptions {
  host?: string;
  port?: number;
  staticDirectory?: string;
}

export function createDashboardApp(staticDirectory = path.resolve("web", "dist")): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
    );
    next();
  });

  app.get("/api/health", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({ ok: true, timestamp_utc: new Date().toISOString() });
  });

  app.get("/api/dashboard", async (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const paths = experimentPaths();
      const [batches, settlements] = await Promise.all([
        loadBatches(paths),
        loadSettlements(paths),
      ]);
      response.json(buildDashboardData(batches, settlements));
    } catch (error) {
      response.status(500).json({
        error: "Dashboard data is temporarily unavailable.",
        detail: safeErrorMessage(error),
      });
    }
  });

  app.use(
    express.static(staticDirectory, {
      immutable: true,
      maxAge: "1h",
      index: false,
    }),
  );

  app.use(async (request, response, next) => {
    if (request.method !== "GET" || !request.accepts("html")) {
      next();
      return;
    }
    const indexPath = path.join(staticDirectory, "index.html");
    try {
      await access(indexPath);
      response.setHeader("Cache-Control", "no-cache");
      response.sendFile(indexPath);
    } catch {
      response.status(503).type("text").send("Dashboard assets have not been built yet.");
    }
  });

  return app;
}

export async function startDashboardServer(
  options: DashboardServerOptions = {},
): Promise<Server> {
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  const app = createDashboardApp(options.staticDirectory);
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      process.stderr.write(`Dashboard listening on http://${host}:${port}\n`);
      resolve(server);
    });
    server.once("error", reject);
  });
}

export async function closeDashboardServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
