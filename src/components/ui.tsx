import clsx from "clsx";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-text">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({ className, children, ...rest }: ComponentProps<"section">) {
  return (
    <section className={clsx("rounded-lg border border-border bg-surface", className)} {...rest}>
      {children}
    </section>
  );
}

export function CardHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-text">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx("p-4", className)}>{children}</div>;
}

type Variant = "primary" | "secondary" | "danger" | "ghost";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover border-transparent",
  secondary: "bg-surface text-text border-border-strong hover:bg-surface-2",
  danger: "bg-surface text-crit border-crit/40 hover:bg-crit-soft",
  ghost: "bg-transparent text-muted border-transparent hover:bg-surface-2 hover:text-text",
};
const SIZES = { sm: "h-7 px-2.5 text-xs", md: "h-9 px-3.5 text-sm" };

export function buttonClass(variant: Variant = "secondary", size: "sm" | "md" = "md") {
  return clsx(
    "inline-flex items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50",
    VARIANTS[variant],
    SIZES[size],
  );
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: ComponentProps<"button"> & { variant?: Variant; size?: "sm" | "md" }) {
  return <button className={clsx(buttonClass(variant, size), className)} {...rest} />;
}

export function LinkButton({
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: ComponentProps<typeof Link> & { variant?: Variant; size?: "sm" | "md" }) {
  return <Link className={clsx(buttonClass(variant, size), className)} {...rest} />;
}

export type Tone = "neutral" | "ok" | "warn" | "crit" | "info" | "demo" | "accent";
const TONES: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted border-border",
  ok: "bg-ok-soft text-ok border-ok/25",
  warn: "bg-warn-soft text-warn border-warn/25",
  crit: "bg-crit-soft text-crit border-crit/25",
  info: "bg-info-soft text-info border-info/25",
  demo: "bg-demo-soft text-demo border-demo/25",
  accent: "bg-accent-soft text-accent border-accent/25",
};

export function Badge({ tone = "neutral", children, title, className }: { tone?: Tone; children: ReactNode; title?: string; className?: string }) {
  return (
    <span
      title={title}
      className={clsx(
        "inline-flex items-center gap-1 rounded border px-1.5 py-px text-[11px] leading-4 font-medium whitespace-nowrap",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Label({ htmlFor, children, hint }: { htmlFor?: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-muted">
      {children}
      {hint ? <span className="ml-1 font-normal text-faint">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  "h-9 w-full rounded-md border border-border-strong bg-surface px-2.5 text-sm text-text placeholder:text-faint focus:border-accent focus:outline-none";

export function Input(props: ComponentProps<"input">) {
  return <input {...props} className={clsx(inputClass, props.className)} />;
}

export function Select(props: ComponentProps<"select">) {
  return <select {...props} className={clsx(inputClass, "pr-8", props.className)} />;
}

export function Textarea(props: ComponentProps<"textarea">) {
  return <textarea {...props} className={clsx(inputClass, "h-auto py-2", props.className)} />;
}

export function Checkbox(props: ComponentProps<"input">) {
  return <input type="checkbox" {...props} className={clsx("size-4 rounded border-border-strong accent-[var(--accent)]", props.className)} />;
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      {icon ? <div className="mb-3 text-faint">{icon}</div> : null}
      <p className="text-sm font-medium text-text">{title}</p>
      {children ? <div className="mt-1 max-w-md text-sm text-muted">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function StatCard({ label, value, hint, href }: { label: string; value: ReactNode; hint?: ReactNode; href?: string }) {
  const body = (
    <>
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="num mt-1 text-2xl font-semibold tracking-tight text-text">{value}</p>
      {hint ? <div className="mt-1 text-xs text-muted">{hint}</div> : null}
    </>
  );
  return href ? (
    <Link href={href} className="block rounded-lg border border-border bg-surface p-4 transition-colors hover:border-border-strong">
      {body}
    </Link>
  ) : (
    <div className="rounded-lg border border-border bg-surface p-4">{body}</div>
  );
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={clsx("w-full text-left text-sm", className)}>{children}</table>
    </div>
  );
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return <th className={clsx("border-b border-border px-4 py-2 text-xs font-medium whitespace-nowrap text-muted", className)}>{children}</th>;
}

export function Td({ children, className, colSpan }: { children?: ReactNode; className?: string; colSpan?: number }) {
  return (
    <td colSpan={colSpan} className={clsx("border-b border-border px-4 py-2.5 align-middle", className)}>
      {children}
    </td>
  );
}

export function Notice({ tone = "info", title, children }: { tone?: Tone; title?: string; children: ReactNode }) {
  const toneClass = TONES[tone];
  return (
    <div role={tone === "crit" ? "alert" : "status"} className={clsx("rounded-md border px-3 py-2 text-sm", toneClass)}>
      {title ? <p className="font-medium">{title}</p> : null}
      <div className={clsx(title && "mt-0.5", "text-text/90")}>{children}</div>
    </div>
  );
}

export function KeyValue({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 border-b border-border/60 py-1.5 sm:block sm:border-0 sm:py-0">
          <dt className="text-xs text-muted">{k}</dt>
          <dd className="text-right text-text sm:mt-0.5 sm:text-left">{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Flash({ ok, error }: { ok?: string | string[]; error?: string | string[] }) {
  const o = Array.isArray(ok) ? ok[0] : ok;
  const e = Array.isArray(error) ? error[0] : error;
  if (!o && !e) return null;
  return (
    <div className="mb-4">
      {e ? <Notice tone="crit">{e}</Notice> : <Notice tone="ok">{o}</Notice>}
    </div>
  );
}
