import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runSchedulerTick } from "@/lib/jobs/scheduler";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.get("authorization") ?? "";
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Scheduled entry point for hosted deployments (e.g. Vercel Cron or any external scheduler). */
export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const summary = await runSchedulerTick();
  return NextResponse.json(summary);
}

export const POST = GET;
