import Link from "next/link";
import { Notice } from "@/components/ui";
import { signIn } from "../actions";
import { AuthForm } from "../auth-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next, error, deleted } = await searchParams;
  return (
    <>
      <h1 className="mb-1 text-lg font-semibold">Sign in</h1>
      <p className="mb-5 text-sm text-muted">Welcome back. Check on your cloud usage.</p>
      {deleted ? (
        <div className="mb-4">
          <Notice tone="ok">Your account and all monitoring data were deleted.</Notice>
        </div>
      ) : null}
      {typeof error === "string" ? (
        <div className="mb-4">
          <Notice tone="crit">{error}</Notice>
        </div>
      ) : null}
      <AuthForm
        action={signIn}
        submit="Sign in"
        hidden={{ next: typeof next === "string" ? next : "/home" }}
        fields={[
          { name: "email", label: "Email", type: "email", autoComplete: "email" },
          { name: "password", label: "Password", type: "password", autoComplete: "current-password" },
        ]}
        footer={
          <div className="space-y-1">
            <p>
              <Link className="text-accent hover:underline" href="/forgot-password">
                Forgot your password?
              </Link>
            </p>
            <p>
              No account?{" "}
              <Link className="text-accent hover:underline" href="/signup">
                Create one
              </Link>
            </p>
          </div>
        }
      />
    </>
  );
}
