/// <reference types="@cloudflare/workers-types" />

import { runScheduledCycle, type CycleEnv } from "./cloudflare-worker.js";

export default {
  async fetch(request: Request, env: CycleEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method !== "POST" || pathname !== "/internal/run-scheduled") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const scheduledTime = Number(request.headers.get("X-Scheduled-Time"));
    if (!Number.isFinite(scheduledTime) || scheduledTime <= 0) {
      return Response.json({ error: "Invalid scheduled time" }, { status: 400 });
    }

    await runScheduledCycle(env, scheduledTime);
    return Response.json({ ok: true, boundary_utc: new Date(scheduledTime).toISOString() });
  },
} satisfies ExportedHandler<CycleEnv>;
