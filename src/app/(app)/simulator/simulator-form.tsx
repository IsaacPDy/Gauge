"use client";

import { type ReactNode, useState } from "react";
import { Card, CardBody, CardHeader, Input, Label, Select } from "@/components/ui";
import { CATALOG } from "@/lib/engine/simulate/catalog";
import {
  clampField,
  clampQps,
  ENUM_FIELDS,
  type EnumField,
  FIELD_GROUPS,
  NUMBER_FIELDS,
  type NumberField,
  type PresetKey,
  PRESET_INFO,
  PRESETS,
  QPS_MAX,
  type SimInputs,
} from "@/lib/engine/simulate/inputs";

/**
 * One form field laid out on its parent's grid rows (label, control, hint), so controls in
 * the same row line up even when a neighbour's label wraps or only one of them has a hint.
 * The parent grid must have no row gap; the field's bottom padding spaces the rows.
 */
function Field({ id, label, hint, children }: { id: string; label: ReactNode; hint?: string; children: ReactNode }) {
  return (
    <div className="row-span-3 grid min-w-0 grid-rows-subgrid pb-3">
      <div className="self-end">
        <Label htmlFor={id}>{label}</Label>
      </div>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-faint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Two-column grid for `Field`s. Its reduced bottom padding offsets the last row's own. */
const FIELD_GRID = "grid grid-cols-2 gap-x-3 pb-1";

interface NumberInputProps {
  id: string;
  label: string;
  unit?: string;
  hint?: string;
  step: number;
  min: number;
  max: number;
  value: number | null;
  placeholder?: string;
  optional?: boolean;
  normalize: (n: number) => number;
  onChange: (v: number | null) => void;
}

/** Keeps the raw text while focused, so partial input like "1." isn't clobbered by clamping. */
function NumberInput({ id, label, unit, hint, step, min, max, value, placeholder, optional, normalize, onChange }: NumberInputProps) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const shown = focused ? text : value === null ? "" : String(value);
  // "Monthly active users (users)" says the same thing twice.
  const showUnit = unit && unit !== "users";
  return (
    <Field
      id={id}
      hint={hint}
      label={
        <>
          {label}
          {showUnit ? <span className="font-normal text-faint"> ({unit})</span> : null}
        </>
      }
    >
      <Input
        id={id}
        aria-describedby={hint ? `${id}-hint` : undefined}
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        placeholder={placeholder}
        value={shown}
        onFocus={() => {
          setText(value === null ? "" : String(value));
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          if (raw.trim() === "") {
            if (optional) onChange(null);
            return;
          }
          const n = Number(raw);
          if (Number.isFinite(n)) onChange(normalize(n));
        }}
      />
    </Field>
  );
}

function FieldInput({ field, inputs, onChange }: { field: NumberField; inputs: SimInputs; onChange: (next: SimInputs) => void }) {
  return (
    <NumberInput
      id={`sim-${field.url}`}
      label={field.label}
      unit={field.unit}
      hint={field.hint}
      step={field.step}
      min={field.min}
      max={field.max}
      value={inputs[field.name]}
      optional={field.optional}
      normalize={(n) => clampField(field, n)}
      onChange={(v) => onChange({ ...inputs, [field.name]: v } as SimInputs)}
    />
  );
}

function EnumInput({
  field,
  inputs,
  onChange,
  disabled,
  hint,
  value,
}: {
  field: EnumField;
  inputs: SimInputs;
  onChange: (next: SimInputs) => void;
  disabled?: boolean;
  hint?: string;
  /** Shown instead of the stored value, e.g. while another choice pins this one. */
  value?: string;
}) {
  const id = `sim-${field.url}`;
  return (
    <Field id={id} label={field.label} hint={hint}>
      <Select
        id={id}
        value={value ?? inputs[field.name]}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange({ ...inputs, [field.name]: e.target.value } as SimInputs)}
      >
        {field.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export function SimulatorForm({
  inputs,
  edited,
  onChange,
  onPreset,
}: {
  inputs: SimInputs;
  edited: boolean;
  onChange: (next: SimInputs) => void;
  onPreset: (preset: PresetKey) => void;
}) {
  const seats = NUMBER_FIELDS.find((f) => f.name === "seats")!;
  // Only the sizes the current plan can use: Free runs on its single size, everything else on the paid ones.
  const planSizes = CATALOG.compute.filter((c) => (inputs.supabase === "free" ? c.key === CATALOG.freeCompute : c.key !== CATALOG.freeCompute));
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Starting point"
          actions={
            edited ? (
              <button type="button" onClick={() => onPreset(inputs.preset)} className="text-xs font-medium text-accent hover:underline">
                Reset to preset
              </button>
            ) : null
          }
        />
        <CardBody>
          <Label htmlFor="sim-preset">Preset</Label>
          <Select id="sim-preset" value={inputs.preset} onChange={(e) => onPreset(e.target.value as PresetKey)}>
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {PRESET_INFO[p].label}
              </option>
            ))}
          </Select>
          <p className="mt-1.5 text-xs text-muted">{PRESET_INFO[inputs.preset].description}</p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Stack" description="Turn on the services you use." />
        <CardBody className={FIELD_GRID}>
          {ENUM_FIELDS.map((f) => (
            <EnumInput
              key={f.name}
              field={f}
              inputs={inputs}
              onChange={onChange}
              disabled={f.name === "compute" && inputs.supabase === "free"}
              hint={f.name === "compute" && inputs.supabase === "free" ? "Free uses Nano" : undefined}
              value={f.name === "compute" && inputs.supabase === "free" ? CATALOG.freeCompute : undefined}
            />
          ))}
          {inputs.vercel === "pro" ? <FieldInput field={seats} inputs={inputs} onChange={onChange} /> : null}
        </CardBody>
      </Card>

      {FIELD_GROUPS.filter((g) => g.key !== "assumptions").map((group) => (
        <Card key={group.key}>
          <CardHeader title={group.label} />
          <CardBody className={FIELD_GRID}>
            {NUMBER_FIELDS.filter((f) => f.group === group.key).map((f) => (
              <FieldInput key={f.name} field={f} inputs={inputs} onChange={onChange} />
            ))}
          </CardBody>
        </Card>
      ))}

      <Card>
        <details>
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-text">Assumptions</summary>
          <div className={`${FIELD_GRID} border-t border-border p-4`}>
            {NUMBER_FIELDS.filter((f) => f.group === "assumptions").map((f) => (
              <FieldInput key={f.name} field={f} inputs={inputs} onChange={onChange} />
            ))}
            <p className="col-span-2 mt-2 mb-3 text-xs text-muted">
              Planning capacity per compute size, in queries/sec. Supabase doesn&apos;t publish these figures; they&apos;re rules of thumb you can tune to your own queries.
            </p>
            {planSizes.map((size) => (
              <NumberInput
                key={size.key}
                id={`sim-qps-${size.key}`}
                label={size.label}
                unit="q/s"
                step={1}
                min={1}
                max={QPS_MAX}
                placeholder={String(size.planningQps)}
                value={inputs.planningQps[size.key] ?? null}
                optional
                normalize={clampQps}
                onChange={(v) => {
                  const planningQps = { ...inputs.planningQps };
                  if (v === null) delete planningQps[size.key];
                  else planningQps[size.key] = v;
                  onChange({ ...inputs, planningQps });
                }}
              />
            ))}
          </div>
        </details>
      </Card>
    </div>
  );
}
