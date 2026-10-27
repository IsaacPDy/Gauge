import { ExternalLink, KeyRound, ShieldCheck } from "lucide-react";
import { Card, CardBody, CardHeader, Flash, LinkButton, Notice, PageHeader } from "@/components/ui";
import { SUPABASE_SCOPES } from "@/lib/providers/supabase/adapter";
import { oauthConfigured, oauthRedirectUri } from "@/lib/providers/supabase/oauth";
import { connectSupabaseToken } from "../../actions";
import { TokenForm } from "../../token-form";

export const metadata = { title: "Connect Supabase" };

export default async function ConnectSupabasePage({ searchParams }: PageProps<"/providers/connect/supabase">) {
  const sp = await searchParams;
  const oauth = oauthConfigured();
  return (
    <>
      <PageHeader
        title="Connect Supabase"
        description="CloudWatch reads organizations, projects and usage through the Supabase Management API. It never asks for database passwords or service-role keys, and never changes your projects."
      />
      <Flash error={sp.error} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={<span className="flex items-center gap-1.5"><ShieldCheck className="size-4 text-ok" aria-hidden /> OAuth (recommended)</span>} description="Grant scoped, read-only access you can revoke from Supabase at any time." />
          <CardBody className="space-y-3">
            <p className="text-sm text-muted">Requested scopes:</p>
            <ul className="flex flex-wrap gap-1.5">
              {SUPABASE_SCOPES.map((s) => (
                <li key={s} className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-xs">
                  {s}
                </li>
              ))}
            </ul>
            {oauth ? (
              <LinkButton href="/api/integrations/supabase/oauth/start" variant="primary" prefetch={false}>
                Authorize with Supabase <ExternalLink className="size-3.5" aria-hidden />
              </LinkButton>
            ) : (
              <Notice tone="warn" title="OAuth is not configured on this server">
                Register an OAuth app in your Supabase organization settings with the redirect URI{" "}
                <code className="font-mono text-xs break-all">{oauthRedirectUri()}</code>, then set{" "}
                <code className="font-mono text-xs">SUPABASE_OAUTH_CLIENT_ID</code> and{" "}
                <code className="font-mono text-xs">SUPABASE_OAUTH_CLIENT_SECRET</code>.
              </Notice>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={<span className="flex items-center gap-1.5"><KeyRound className="size-4 text-muted" aria-hidden /> Personal access token</span>} description="Works without an OAuth app. Create one under Account → Access Tokens in Supabase." />
          <CardBody className="space-y-4">
            <Notice tone="warn">
              Supabase personal access tokens are not scoped: they carry your full account access. CloudWatch only sends read
              requests, encrypts the token at rest and never shows it again, but prefer OAuth when possible. Revoke the token in
              Supabase when you disconnect.
            </Notice>
            <TokenForm action={connectSupabaseToken} withLabel submit="Validate and connect" />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
