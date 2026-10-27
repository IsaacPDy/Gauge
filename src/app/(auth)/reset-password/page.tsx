import { updatePassword } from "../actions";
import { AuthForm } from "../auth-form";

export const metadata = { title: "Choose a new password" };

export default function ResetPasswordPage() {
  return (
    <>
      <h1 className="mb-1 text-lg font-semibold">Choose a new password</h1>
      <p className="mb-5 text-sm text-muted">You followed a recovery link. Set a new password to continue.</p>
      <AuthForm
        action={updatePassword}
        submit="Update password"
        fields={[
          { name: "password", label: "New password", type: "password", autoComplete: "new-password", hint: "(8+ characters)" },
          { name: "confirm", label: "Confirm password", type: "password", autoComplete: "new-password" },
        ]}
      />
    </>
  );
}
