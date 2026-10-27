"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ComponentProps } from "react";
import { useFormStatus } from "react-dom";
import { buttonClass } from "./ui";

type Variant = "primary" | "secondary" | "danger" | "ghost";

/** Submit button that disables itself while its form's server action runs. */
export function SubmitButton({
  children,
  pendingText,
  variant = "primary",
  size = "md",
  confirm,
  className,
  ...rest
}: ComponentProps<"button"> & { pendingText?: string; variant?: Variant; size?: "sm" | "md"; confirm?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || rest.disabled}
      aria-disabled={pending}
      className={`${buttonClass(variant, size)} ${className ?? ""}`}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
      {...rest}
    >
      {pending ? (pendingText ?? "Working…") : children}
    </button>
  );
}

/** Re-fetches server data periodically while something is in progress (e.g. a sync). */
export function AutoRefresh({ active, seconds = 4 }: { active: boolean; seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [active, seconds, router]);
  return null;
}

/** Select that submits its form when changed (keyboard users can still use the button). */
export function AutoSubmitSelect(props: ComponentProps<"select">) {
  return (
    <select
      {...props}
      onChange={(e) => {
        props.onChange?.(e);
        e.currentTarget.form?.requestSubmit();
      }}
    />
  );
}
