/// <reference types="@cloudflare/workers-types" />

import { runForecastCycle, type CycleEnv } from "./cloudflare-cycle.js";

export default {
  async fetch(request: Request, env: CycleEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method !== "POST" || pathname !== "/internal/run-scheduled") return Response.json({ error: "Not found" }, { status: 404 });
    const scheduledTime = Number(request.headers.get("X-Scheduled-Time"));
    if (!Number.isFinite(scheduledTime) || scheduledTime <= 0) return Response.json({ error: "Invalid scheduled time" }, { status: 400 });
    return Response.json(await runForecastCycle(env, scheduledTime));
  },
} satisfies ExportedHandler<CycleEnv>;
