import Link from "next/link";
import { signUp } from "../actions";
import { AuthForm } from "../auth-form";

export const metadata = { title: "Create account" };

export default function SignupPage() {
  return (
    <>
      <h1 className="mb-1 text-lg font-semibold">Create your account</h1>
      <p className="mb-5 text-sm text-muted">A private workspace is created for you automatically.</p>
      <AuthForm
        action={signUp}
        submit="Create account"
        fields={[
          { name: "email", label: "Email", type: "email", autoComplete: "email" },
          { name: "password", label: "Password", type: "password", autoComplete: "new-password", hint: "(8+ characters)" },
        ]}
        footer={
          <p>
            Already registered?{" "}
            <Link className="text-accent hover:underline" href="/login">
              Sign in
            </Link>
          </p>
        }
      />
    </>
  );
}
