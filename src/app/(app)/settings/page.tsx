import { SubmitButton } from "@/components/form-controls";
import { Card, CardBody, CardHeader, Checkbox, Flash, Input, KeyValue, Label, Notice, PageHeader, Select } from "@/components/ui";
import { getProfile } from "@/db/repos/account";
import { getSession } from "@/lib/session";
import { changePassword, deleteAccount, updateNotifications, updateProfile, updateWorkspace } from "./actions";

export const metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const sp = await searchParams;
  const { scope, user, workspace } = await getSession();
  const profile = await getProfile(scope);

  return (
    <>
      <PageHeader title="Settings" description="Account, workspace, notifications and monitoring preferences." />
      <Flash ok={sp.ok} error={sp.error} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Account" />
          <CardBody className="space-y-4">
            <KeyValue items={[["Email", user.email ?? "—"], ["Member since", profile ? new Date(profile.created_at).toUTCString().slice(5, 16) : "—"]]} />
            <form action={updateProfile} className="flex items-end gap-2">
              <div className="flex-1">
                <Label htmlFor="displayName">Display name</Label>
                <Input id="displayName" name="displayName" defaultValue={profile?.display_name ?? ""} maxLength={80} />
              </div>
              <SubmitButton variant="secondary" pendingText="Saving…">
                Save
              </SubmitButton>
            </form>
            <form action="/auth/signout" method="post">
              <button type="submit" className="text-sm text-accent hover:underline">
                Sign out
              </button>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Change password" />
          <CardBody>
            <form action={changePassword} className="space-y-3">
              <div>
                <Label htmlFor="current">Current password</Label>
                <Input id="current" name="current" type="password" autoComplete="current-password" required />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="password">New password</Label>
                  <Input id="password" name="password" type="password" autoComplete="new-password" minLength={8} required />
                </div>
                <div>
                  <Label htmlFor="confirm">Confirm</Label>
                  <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={8} required />
                </div>
              </div>
              <SubmitButton variant="secondary" pendingText="Updating…">
                Change password
              </SubmitButton>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Workspace" description="One owner per workspace for now; team invitations are planned." />
          <CardBody>
            <form action={updateWorkspace} className="flex items-end gap-2">
              <div className="flex-1">
                <Label htmlFor="wsname">Workspace name</Label>
                <Input id="wsname" name="name" defaultValue={workspace.name} maxLength={80} required />
              </div>
              <SubmitButton variant="secondary" pendingText="Saving…">
                Rename
              </SubmitButton>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Notifications & monitoring" />
          <CardBody>
            <form action={updateNotifications} className="space-y-4">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox name="notify_in_app" defaultChecked={workspace.notify_in_app} /> In-app notifications
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox name="notify_email" defaultChecked={workspace.notify_email} /> Email notifications
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="email_min_severity">Email me for</Label>
                  <Select id="email_min_severity" name="email_min_severity" defaultValue={workspace.email_min_severity}>
                    <option value="info">All alerts (info and above)</option>
                    <option value="warning">Warning and above</option>
                    <option value="critical">Critical and above</option>
                    <option value="limit_reached">Limit reached only</option>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="alert_email" hint="(defaults to your login email)">
                    Send alerts to
                  </Label>
                  <Input id="alert_email" name="alert_email" type="email" defaultValue={workspace.alert_email ?? ""} placeholder={user.email} />
                </div>
              </div>
              <div className="max-w-xs">
                <Label htmlFor="stale_after_hours" hint="(hours)">
                  Treat data as stale after
                </Label>
                <Input id="stale_after_hours" name="stale_after_hours" type="number" min={1} max={720} defaultValue={workspace.stale_after_hours} />
              </div>
              <SubmitButton variant="secondary" pendingText="Saving…">
                Save preferences
              </SubmitButton>
            </form>
          </CardBody>
        </Card>
      </div>

      <Card className="mt-6 border-crit/40">
        <CardHeader title="Delete account" description="Permanently deletes your account, workspace, connections, usage history and alerts." />
        <CardBody className="space-y-3">
          <Notice tone="warn">
            Stored provider credentials are deleted and OAuth grants are revoked. For personal access tokens, also revoke them in each
            provider&apos;s settings. This cannot be undone.
          </Notice>
          <form action={deleteAccount} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Label htmlFor="confirm-delete">Type {user.email} to confirm</Label>
              <Input id="confirm-delete" name="confirm" autoComplete="off" />
            </div>
            <SubmitButton variant="danger" confirm="Delete your account and all data permanently?" pendingText="Deleting…">
              Delete account
            </SubmitButton>
          </form>
        </CardBody>
      </Card>
    </>
  );
}
