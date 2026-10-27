import { AlertOctagon, AlertTriangle, CheckCircle2, Clock, Info, Loader2, PlugZap, ShieldAlert, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { CapabilityLevel } from "@/lib/providers/types";
import { formatPercent } from "@/lib/units";
import { Badge, type Tone } from "./ui";

// Every status shows an icon and a text label so meaning never depends on color alone.

const CONNECTION: Record<string, { tone: Tone; label: string; icon: ReactNode }> = {
  connected: { tone: "ok", label: "Connected", icon: <CheckCircle2 className="size-3" aria-hidden /> },
  syncing: { tone: "info", label: "Syncing", icon: <Loader2 className="size-3 animate-spin" aria-hidden /> },
  reauth_required: { tone: "crit", label: "Reauthorization required", icon: <ShieldAlert className="size-3" aria-hidden /> },
  permission_insufficient: { tone: "crit", label: "Permission insufficient", icon: <ShieldAlert className="size-3" aria-hidden /> },
  unsupported_capability: { tone: "warn", label: "Unsupported capability", icon: <AlertTriangle className="size-3" aria-hidden /> },
  error: { tone: "crit", label: "Connection error", icon: <XCircle className="size-3" aria-hidden /> },
  disconnected: { tone: "neutral", label: "Disconnected", icon: <PlugZap className="size-3" aria-hidden /> },
};

export function ConnectionStatusBadge({ status, syncing }: { status: string; syncing?: boolean }) {
  const s = syncing && status !== "disconnected" ? CONNECTION.syncing : (CONNECTION[status] ?? CONNECTION.error);
  return (
    <Badge tone={s.tone}>
      {s.icon}
      {s.label}
    </Badge>
  );
}

const SEVERITY: Record<string, { tone: Tone; label: string; icon: ReactNode }> = {
  info: { tone: "info", label: "Info", icon: <Info className="size-3" aria-hidden /> },
  warning: { tone: "warn", label: "Warning", icon: <AlertTriangle className="size-3" aria-hidden /> },
  critical: { tone: "crit", label: "Critical", icon: <AlertOctagon className="size-3" aria-hidden /> },
  limit_reached: { tone: "crit", label: "Limit reached", icon: <XCircle className="size-3" aria-hidden /> },
};

export function SeverityBadge({ severity }: { severity: string }) {
  const s = SEVERITY[severity] ?? SEVERITY.info;
  return (
    <Badge tone={s.tone}>
      {s.icon}
      {s.label}
    </Badge>
  );
}

const ALERT_STATUS: Record<string, Tone> = {
  open: "crit",
  acknowledged: "neutral",
  muted: "neutral",
  resolved: "ok",
  superseded: "neutral",
};

export function AlertStatusBadge({ status }: { status: string }) {
  return <Badge tone={ALERT_STATUS[status] ?? "neutral"}>{status[0].toUpperCase() + status.slice(1)}</Badge>;
}

export const CATEGORY_LABEL: Record<string, string> = {
  quota_threshold: "Quota threshold",
  forecast_breach: "Forecasted breach",
  cost_overage: "Projected cost",
  integration_health: "Monitoring health",
};

/** Data transparency labels (PRD §13). */
export function SourceBadge({ kind }: { kind: "reported" | "derived" | "estimated" | "demo" | "user" | "provider" | "unknown" | "stale" | "unsupported" | "missing" }) {
  const map: Record<string, [Tone, string, string]> = {
    reported: ["neutral", "Reported", "Value reported by the provider"],
    derived: ["neutral", "Derived", "Calculated from provider data"],
    estimated: ["warn", "Estimate", "Approximation; may differ from the provider's billing"],
    demo: ["demo", "Demo data", "Generated sample data from the Demo provider"],
    user: ["accent", "Your limit", "Limit configured by you"],
    provider: ["neutral", "Provider limit", "Limit reported by the provider's API"],
    unknown: ["warn", "Unknown limit", "No reliable allowance is known; set one to enable alerts"],
    stale: ["warn", "Stale", "Latest successful data is older than your freshness threshold"],
    unsupported: ["neutral", "Unsupported", "This integration cannot provide this data"],
    missing: ["neutral", "No data", "No measurements collected yet; not treated as zero"],
  };
  const [tone, label, title] = map[kind];
  return (
    <Badge tone={tone} title={title}>
      {kind === "stale" ? <Clock className="size-3" aria-hidden /> : null}
      {label}
    </Badge>
  );
}

export function CapabilityBadge({ level }: { level: CapabilityLevel }) {
  const map: Record<CapabilityLevel, [Tone, string]> = {
    supported: ["ok", "Supported"],
    partial: ["warn", "Partial"],
    unsupported: ["neutral", "Unsupported"],
  };
  const [tone, label] = map[level];
  return <Badge tone={tone}>{label}</Badge>;
}

function riskTone(percent: number | null): "ok" | "info" | "warn" | "crit" {
  if (percent === null) return "info";
  if (percent >= 90) return "crit";
  if (percent >= 75) return "warn";
  if (percent >= 50) return "info";
  return "ok";
}

const BAR: Record<string, string> = { ok: "bg-ok", info: "bg-info", warn: "bg-warn", crit: "bg-crit" };

/** Accessible usage bar with threshold ticks; the percentage is always printed as text. */
export function UsageBar({
  percent,
  projectedPercent,
  thresholds = [50, 75, 90],
  label,
}: {
  percent: number | null;
  projectedPercent?: number | null;
  thresholds?: number[];
  label: string;
}) {
  const tone = riskTone(percent);
  const width = percent === null ? 0 : Math.min(100, percent);
  const projected = projectedPercent === null || projectedPercent === undefined ? null : Math.min(100, projectedPercent);
  return (
    <div className="flex items-center gap-2">
      <div
        className="relative h-2 flex-1 overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : Math.round(Math.min(percent, 100))}
        aria-valuetext={percent === null ? "Unknown" : `${formatPercent(percent)} used`}
      >
        {projected !== null && projected > width ? (
          <div
            className="absolute inset-y-0 left-0 rounded-full opacity-25"
            style={{ width: `${projected}%`, background: "repeating-linear-gradient(45deg, var(--muted) 0 3px, transparent 3px 6px)" }}
            aria-hidden
          />
        ) : null}
        <div className={`absolute inset-y-0 left-0 rounded-full ${BAR[tone]}`} style={{ width: `${width}%` }} />
        {thresholds.map((t) => (
          <div key={t} className="absolute inset-y-0 w-px bg-surface" style={{ left: `${t}%` }} aria-hidden />
        ))}
      </div>
      <span className="num w-12 shrink-0 text-right text-xs font-medium text-text">{percent === null ? "—" : formatPercent(percent)}</span>
    </div>
  );
}

export function RiskLabel({ percent, projectedBreach }: { percent: number | null; projectedBreach?: boolean }) {
  if (percent === null) return <Badge>Unknown</Badge>;
  if (projectedBreach && percent < 75) {
    return (
      <Badge tone="warn" title="Forecast (estimate) expects the limit to be crossed">
        <AlertTriangle className="size-3" aria-hidden />
        Projected to exceed
      </Badge>
    );
  }
  if (percent >= 100) return <SeverityBadge severity="limit_reached" />;
  if (percent >= 90) return <SeverityBadge severity="critical" />;
  if (percent >= 75) return <SeverityBadge severity="warning" />;
  if (percent >= 50) return <SeverityBadge severity="info" />;
  return (
    <Badge tone="ok">
      <CheckCircle2 className="size-3" aria-hidden />
      OK
    </Badge>
  );
}
