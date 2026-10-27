"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/form-controls";
import { Input, Label, Notice, Select } from "@/components/ui";
import { saveQuota } from "./actions";

export function QuotaForm({
  metricKey,
  unit,
  scopeType,
  scopeId,
  back,
  quotaId,
  defaults,
}: {
  metricKey: string;
  unit: string;
  scopeType: "account" | "resource";
  scopeId: string;
  back: string;
  quotaId?: string;
  defaults?: { limit?: string; overageEffect?: string; notes?: string | null; thresholds?: string };
}) {
  const [state, action] = useActionState(saveQuota, undefined);
  const id = (s: string) => `${s}-${scopeId}-${metricKey}`;
  return (
    <form action={action} className="space-y-3">
      {state?.error ? <Notice tone="crit">{state.error}</Notice> : null}
      <input type="hidden" name="metricKey" value={metricKey} />
      <input type="hidden" name="scopeType" value={scopeType} />
      <input type="hidden" name="scopeId" value={scopeId} />
      <input type="hidden" name="back" value={back} />
      {quotaId ? <input type="hidden" name="quotaId" value={quotaId} /> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor={id("limit")} hint={unit === "bytes" ? "(e.g. 500 MB, 8 GB)" : "(e.g. 50000 or 100k)"}>
            Limit
          </Label>
          <Input id={id("limit")} name="limit" defaultValue={defaults?.limit} required />
        </div>
        <div>
          <Label htmlFor={id("effect")}>When exceeded</Label>
          <Select id={id("effect")} name="overageEffect" defaultValue={defaults?.overageEffect ?? "unknown"}>
            <option value="charges">Usage is billed</option>
            <option value="restriction">Service is restricted</option>
            <option value="both">Billed or restricted (depends on plan settings)</option>
            <option value="none">Nothing — it is my own budget</option>
            <option value="unknown">Not sure</option>
          </Select>
        </div>
      </div>
      <div>
        <Label htmlFor={id("thresholds")} hint="(optional; default 50/75/90/100%)">
          Custom alert thresholds
        </Label>
        <Input id={id("thresholds")} name="thresholds" defaultValue={defaults?.thresholds} placeholder="80:warning, 95:critical, 100:limit_reached" />
      </div>
      <div>
        <Label htmlFor={id("notes")} hint="(optional)">
          Notes
        </Label>
        <Input id={id("notes")} name="notes" defaultValue={defaults?.notes ?? ""} maxLength={500} placeholder="Where this number comes from" />
      </div>
      <SubmitButton pendingText="Saving…">{quotaId ? "Update limit" : "Save limit"}</SubmitButton>
    </form>
  );
}
