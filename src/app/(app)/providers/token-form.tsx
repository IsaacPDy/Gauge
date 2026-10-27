"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/form-controls";
import { Input, Label, Notice } from "@/components/ui";
import type { FormState } from "./actions";

export function TokenForm({
  action,
  connectionId,
  withLabel,
  submit,
}: {
  action: (s: FormState, f: FormData) => Promise<FormState>;
  connectionId?: string;
  withLabel?: boolean;
  submit: string;
}) {
  const [state, formAction] = useActionState(action, undefined);
  return (
    <form action={formAction} className="space-y-3" autoComplete="off">
      {state?.error ? <Notice tone="crit">{state.error}</Notice> : null}
      {connectionId ? <input type="hidden" name="connectionId" value={connectionId} /> : null}
      {withLabel ? (
        <div>
          <Label htmlFor="label">Connection name</Label>
          <Input id="label" name="label" defaultValue="Supabase" maxLength={80} required />
        </div>
      ) : null}
      <div>
        <Label htmlFor="token" hint="(starts with sbp_)">
          Personal access token
        </Label>
        <Input id="token" name="token" type="password" autoComplete="off" spellCheck={false} placeholder="sbp_…" required />
      </div>
      <SubmitButton pendingText="Validating and discovering…">{submit}</SubmitButton>
    </form>
  );
}
