#!/usr/bin/env node
import "dotenv/config";
import { startDashboardServer } from "./dashboard-server.js";
import { safeErrorMessage } from "./http.js";

startDashboardServer().catch((error) => {
  process.stderr.write(`Dashboard failed: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
