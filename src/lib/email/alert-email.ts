import type { Unit } from "../types";
import { formatPercent, formatValue } from "../units";
import type { EmailMessage } from "./transport";

export interface AlertEmailInput {
  to: string;
  appUrl: string;
  alert: {
    id: string;
    title: string;
    message: string;
    severity: string;
    category: string;
    recommended_action: string | null;
    current_value: number | null;
    limit_value: number | null;
    unit: string | null;
    percent_used: number | null;
    cycle_reset_at: string | null;
    forecast_breach_at: string | null;
    data_updated_at: string | null;
    metric_key: string | null;
  };
  metricName: string | null;
  providerLabel: string | null;
  scopeName: string | null;
  applicationName: string | null;
}

const SEVERITY_LABEL: Record<string, string> = {
  info: "Info",
  warning: "Warning",
  critical: "Critical",
  limit_reached: "Limit reached",
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const date = (iso: string | null) => (iso ? new Date(iso).toUTCString().replace(" GMT", " UTC") : null);

export function renderAlertEmail(input: AlertEmailInput): EmailMessage {
  const { alert: a } = input;
  const unit = (a.unit ?? "count") as Unit;
  const rows: [string, string | null][] = [
    ["Application", input.applicationName],
    ["Provider", input.providerLabel],
    ["Scope", input.scopeName],
    ["Metric", input.metricName],
    ["Current consumption", a.current_value === null ? null : formatValue(Number(a.current_value), unit)],
    ["Applicable limit", a.limit_value === null ? null : formatValue(Number(a.limit_value), unit)],
    ["Percentage used", a.percent_used === null ? null : formatPercent(Number(a.percent_used))],
    ["Billing cycle resets", date(a.cycle_reset_at)],
    ["Forecasted breach (estimate)", date(a.forecast_breach_at)],
    ["Last data update", date(a.data_updated_at)],
  ];
  const shown = rows.filter((r): r is [string, string] => r[1] !== null);
  const link = `${input.appUrl}/alerts/${a.id}`;
  const severity = SEVERITY_LABEL[a.severity] ?? a.severity;
  const disclaimer =
    "Limit Gauge alerts are monitoring notices, not spending caps. Estimates can differ from your provider's invoice, which is authoritative.";

  const text = [
    `${severity}: ${a.title}`,
    "",
    a.message,
    "",
    ...shown.map(([k, v]) => `${k}: ${v}`),
    "",
    a.recommended_action ? `Recommended next step: ${a.recommended_action}` : "",
    "",
    `View alert: ${link}`,
    "",
    disclaimer,
  ].join("\n");

  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111827;background:#f9fafb;padding:24px">
<table role="presentation" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:24px">
<tr><td>
<p style="margin:0 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280">Limit Gauge · ${esc(severity)}</p>
<h1 style="margin:0 0 12px;font-size:18px">${esc(a.title)}</h1>
<p style="margin:0 0 16px;line-height:1.5">${esc(a.message)}</p>
<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px">
${shown.map(([k, v]) => `<tr><td style="padding:4px 0;color:#6b7280">${esc(k)}</td><td style="padding:4px 0;text-align:right">${esc(v)}</td></tr>`).join("")}
</table>
${a.recommended_action ? `<p style="margin:0 0 16px;line-height:1.5"><strong>Recommended next step:</strong> ${esc(a.recommended_action)}</p>` : ""}
<p style="margin:0 0 16px"><a href="${esc(link)}" style="background:#2563eb;color:#fff;text-decoration:none;padding:8px 14px;border-radius:6px;display:inline-block">View alert</a></p>
<p style="margin:0;font-size:12px;color:#6b7280">${esc(disclaimer)}</p>
</td></tr></table></body></html>`;

  return { to: input.to, subject: `[Limit Gauge] ${severity}: ${a.title}`, text, html };
}
