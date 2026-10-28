import Link from "next/link";
import { Notice } from "@/components/ui";
import { updatePassword } from "../actions";
import { AuthForm } from "../auth-form";

export const metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  const { token, error } = await searchParams;
  if (typeof token !== "string" || typeof error === "string") {
    return (
      <>
        <h1 className="mb-1 text-lg font-semibold">Choose a new password</h1>
        <div className="my-4">
          <Notice tone="crit">This reset link is invalid or has expired.</Notice>
        </div>
        <Link className="text-sm text-accent hover:underline" href="/forgot-password">
          Request a new link
        </Link>
      </>
    );
  }
  return (
    <>
      <h1 className="mb-1 text-lg font-semibold">Choose a new password</h1>
      <p className="mb-5 text-sm text-muted">You followed a recovery link. Set a new password to continue.</p>
      <AuthForm
        action={updatePassword}
        submit="Update password"
        hidden={{ token }}
        fields={[
          { name: "password", label: "New password", type: "password", autoComplete: "new-password", hint: "(8+ characters)" },
          { name: "confirm", label: "Confirm password", type: "password", autoComplete: "new-password" },
        ]}
      />
    </>
  );
}
