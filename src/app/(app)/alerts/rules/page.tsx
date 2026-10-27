import { SubmitButton } from "@/components/form-controls";
import { CATEGORY_LABEL } from "@/components/status";
import { Card, CardBody, CardHeader, Checkbox, Flash, Input, PageHeader, Select } from "@/components/ui";
import { normalizeThresholds } from "@/lib/engine/alerts";
import { getSession } from "@/lib/session";
import { DEFAULT_THRESHOLDS } from "@/lib/types";
import { saveAlertRules } from "../actions";

export const metadata = { title: "Alert rules" };

const DESCRIPTIONS: Record<string, string> = {
  quota_threshold: "Fires when usage crosses a percentage of an applicable limit. Each threshold notifies once per billing cycle; higher thresholds escalate.",
  forecast_breach: "Fires when the deterministic forecast projects the limit will be crossed before the cycle ends (needs at least 3 days of data).",
  cost_overage: "Fires when estimated overage charges are above zero, based on versioned pricing rules. Always labelled as an estimate.",
  integration_health: "Fires when a connection needs reauthorization, lacks permissions, keeps failing, or its data becomes stale.",
};
const ORDER = ["quota_threshold", "forecast_breach", "cost_overage", "integration_health"];

export default async function AlertRulesPage({ searchParams }: PageProps<"/alerts/rules">) {
  const sp = await searchParams;
  const { supabase, workspace } = await getSession();
  const { data } = await supabase.from("alert_rules").select("*");
  const rules = [...(data ?? [])].sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category));
  const quotaRule = rules.find((r) => r.category === "quota_threshold");
  const thresholds = normalizeThresholds(quotaRule?.thresholds) ?? DEFAULT_THRESHOLDS;
  const rows = [...thresholds, ...Array.from({ length: Math.max(0, 6 - thresholds.length) }, () => null)];

  return (
    <>
      <PageHeader
        title="Alert rules"
        description={
          <>
            Workspace-wide rules. Individual limits can override thresholds on the Limits page. Email delivery also follows your{" "}
            <a href="/settings" className="text-accent hover:underline">
              notification settings
            </a>{" "}
            (currently: {workspace.notify_email ? `email for ${workspace.email_min_severity.replace("_", " ")} and above` : "email off"}).
          </>
        }
      />
      <Flash ok={sp.ok} error={sp.error} />
      <form action={saveAlertRules} className="space-y-4">
        {rules.map((r) => (
          <Card key={r.id}>
            <CardHeader
              title={
                <label className="flex items-center gap-2">
                  <Checkbox name={`${r.category}.enabled`} defaultChecked={r.enabled} />
                  {CATEGORY_LABEL[r.category]}
                </label>
              }
              description={DESCRIPTIONS[r.category]}
              actions={
                <div className="flex items-center gap-4 text-xs">
                  <label className="flex items-center gap-1.5">
                    <Checkbox name={`${r.category}.in_app`} defaultChecked={r.notify_in_app} /> In-app
                  </label>
                  <label className="flex items-center gap-1.5">
                    <Checkbox name={`${r.category}.email`} defaultChecked={r.notify_email} /> Email
                  </label>
                </div>
              }
            />
            {r.category === "quota_threshold" ? (
              <CardBody>
                <p className="mb-2 text-xs text-muted">Thresholds (leave a percentage empty to remove a row)</p>
                <div className="grid max-w-md gap-2">
                  {rows.map((t, i) => (
                    <div key={i} className="grid grid-cols-[6rem_1fr] items-center gap-2">
                      <div className="relative">
                        <Input
                          name="threshold.percent"
                          type="number"
                          min={1}
                          max={1000}
                          step="any"
                          defaultValue={t?.percent ?? ""}
                          aria-label={`Threshold ${i + 1} percent`}
                          className="pr-6"
                        />
                        <span className="pointer-events-none absolute top-2 right-2.5 text-xs text-faint">%</span>
                      </div>
                      <Select name="threshold.severity" defaultValue={t?.severity ?? "warning"} aria-label={`Threshold ${i + 1} severity`}>
                        <option value="info">Informational</option>
                        <option value="warning">Warning</option>
                        <option value="critical">Critical</option>
                        <option value="limit_reached">Limit reached</option>
                      </Select>
                    </div>
                  ))}
                </div>
              </CardBody>
            ) : null}
          </Card>
        ))}
        <SubmitButton pendingText="Saving…">Save rules</SubmitButton>
      </form>
    </>
  );
}
