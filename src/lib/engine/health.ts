import type { ConnectionStatus } from "../types";
import { HOUR_MS } from "./time";

export type HealthState = "healthy" | "syncing" | "stale" | "failing" | "never_synced" | "disconnected";

export interface ConnectionHealthInput {
  status: ConnectionStatus;
  lastSuccessAt: Date | null;
  createdAt: Date;
  consecutiveFailures: number;
}

export interface ConnectionHealth {
  state: HealthState;
  /** Monitoring data from this connection can be relied on. */
  reliable: boolean;
  label: string;
}

const FAILING: ConnectionStatus[] = ["reauth_required", "permission_insufficient", "error", "unsupported_capability"];

export function connectionHealth(c: ConnectionHealthInput, now: Date, staleAfterHours: number): ConnectionHealth {
  if (c.status === "disconnected") return { state: "disconnected", reliable: false, label: "Disconnected" };
  if (FAILING.includes(c.status)) return { state: "failing", reliable: false, label: "Monitoring failing" };
  const staleMs = staleAfterHours * HOUR_MS;
  if (!c.lastSuccessAt) {
    if (now.getTime() - c.createdAt.getTime() > staleMs) {
      return { state: "stale", reliable: false, label: "No successful sync yet" };
    }
    return { state: c.status === "syncing" ? "syncing" : "never_synced", reliable: false, label: "Waiting for first sync" };
  }
  if (now.getTime() - c.lastSuccessAt.getTime() > staleMs) {
    return { state: "stale", reliable: false, label: "Data is stale" };
  }
  if (c.status === "syncing") return { state: "syncing", reliable: true, label: "Syncing" };
  return { state: "healthy", reliable: true, label: c.consecutiveFailures > 0 ? "Healthy (recent retry)" : "Healthy" };
}

export function isStale(observedAt: Date | null, now: Date, staleAfterHours: number): boolean {
  if (!observedAt) return true;
  return now.getTime() - observedAt.getTime() > staleAfterHours * HOUR_MS;
}
