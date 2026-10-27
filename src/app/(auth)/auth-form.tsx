"use client";

import { useActionState, type ReactNode } from "react";
import { SubmitButton } from "@/components/form-controls";
import { Input, Label, Notice } from "@/components/ui";
import type { AuthState } from "./actions";

type Field = { name: string; label: string; type: string; autoComplete: string; hint?: string };

export function AuthForm({
  action,
  fields,
  submit,
  hidden,
  footer,
}: {
  action: (state: AuthState, form: FormData) => Promise<AuthState>;
  fields: Field[];
  submit: string;
  hidden?: Record<string, string>;
  footer?: ReactNode;
}) {
  const [state, formAction] = useActionState(action, undefined);
  return (
    <form action={formAction} className="space-y-4" noValidate>
      {state?.error ? <Notice tone="crit">{state.error}</Notice> : null}
      {state?.ok ? <Notice tone="ok">{state.ok}</Notice> : null}
      {Object.entries(hidden ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {fields.map((f) => (
        <div key={f.name}>
          <Label htmlFor={f.name} hint={f.hint}>
            {f.label}
          </Label>
          <Input id={f.name} name={f.name} type={f.type} autoComplete={f.autoComplete} required />
        </div>
      ))}
      <SubmitButton className="w-full" pendingText="Please wait…">
        {submit}
      </SubmitButton>
      {footer ? <div className="text-center text-sm text-muted">{footer}</div> : null}
    </form>
  );
}
