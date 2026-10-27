import { Boxes } from "lucide-react";
import Link from "next/link";
import { SubmitButton } from "@/components/form-controls";
import { RiskLabel, SeverityBadge } from "@/components/status";
import { Badge, Card, CardBody, CardHeader, EmptyState, Flash, Input, Label, PageHeader } from "@/components/ui";
import { loadInventory, loadQuotaViews } from "@/lib/data/views";
import { PROVIDER_NAMES } from "@/lib/providers/registry";
import { getSession } from "@/lib/session";
import { createApplication } from "./actions";

export const metadata = { title: "Applications" };

export default async function ApplicationsPage({ searchParams }: PageProps<"/applications">) {
  const sp = await searchParams;
  const { supabase } = await getSession();
  const inv = await loadInventory(supabase);
  const quotas = await loadQuotaViews(supabase, inv);
  const { data: openAlerts } = await supabase.from("alerts").select("id, application_id, resource_id, severity, title, created_at").eq("status", "open").order("created_at", { ascending: false });

  return (
    <>
      <PageHeader
        title="Applications"
        description="Your own grouping of provider resources by product. One application can span several providers; provider billing scopes are kept separate."
      />
      <Flash ok={sp.ok} error={sp.error} />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div>
          {inv.applications.length === 0 ? (
            <Card>
              <EmptyState icon={<Boxes className="size-8" />} title="No applications yet">
                Create one for each product you run, then add its database, hosting and other resources.
              </EmptyState>
            </Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {inv.applications.map((app) => {
                const resources = inv.resources.filter((r) => inv.appByResource.get(r.id)?.id === app.id);
                const ids = new Set(resources.map((r) => r.id));
                const risk = Math.max(
                  -1,
                  ...quotas.filter((q) => q.evaluation?.isEffective && q.resourceId && ids.has(q.resourceId)).map((q) => q.evaluation!.percent ?? -1),
                );
                const alerts = (openAlerts ?? []).filter((a) => a.application_id === app.id || (a.resource_id && ids.has(a.resource_id)));
                const providers = [...new Set(resources.map((r) => r.provider))];
                return (
                  <Link key={app.id} href={`/applications/${app.id}`} className="rounded-lg border border-border bg-surface p-4 transition-colors hover:border-border-strong">
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-medium">{app.name}</p>
                      <RiskLabel percent={risk < 0 ? null : risk} />
                    </div>
                    {app.description ? <p className="mt-1 line-clamp-2 text-xs text-muted">{app.description}</p> : null}
                    <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                      {resources.length} resource{resources.length === 1 ? "" : "s"}
                      {providers.map((p) => (
                        <Badge key={p} tone={p === "demo" ? "demo" : "neutral"}>
                          {PROVIDER_NAMES[p] ?? p}
                        </Badge>
                      ))}
                    </p>
                    {alerts[0] ? (
                      <p className="mt-2 flex items-center gap-1.5 text-xs">
                        <SeverityBadge severity={alerts[0].severity} />
                        <span className="truncate text-muted">{alerts[0].title}</span>
                      </p>
                    ) : null}
                  </Link>
                );
              })}
            </div>
          )}
        </div>
        <Card className="h-fit">
          <CardHeader title="New application" />
          <CardBody>
            <form action={createApplication} className="space-y-3">
              <div>
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" required maxLength={80} placeholder="e.g. Recipe app" />
              </div>
              <div>
                <Label htmlFor="description" hint="(optional)">
                  Description
                </Label>
                <Input id="description" name="description" maxLength={500} placeholder="Client, purpose, environment…" />
              </div>
              <SubmitButton pendingText="Creating…">Create application</SubmitButton>
            </form>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
