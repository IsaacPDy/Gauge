import { ArrowRight, Cloud, FlaskConical } from "lucide-react";
import Link from "next/link";
import { ConnectionStatusBadge } from "@/components/status";
import { TimeAgo } from "@/components/time";
import { Badge, Card, CardHeader, EmptyState, Flash, LinkButton, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/form-controls";
import { isSyncing, loadInventory } from "@/lib/data/views";
import { demoEnabled, PROVIDER_CATALOG, PROVIDER_CATEGORIES, PROVIDER_NAMES } from "@/lib/providers/registry";
import { getSession } from "@/lib/session";
import { connectDemo } from "./actions";

export const metadata = { title: "Providers" };

export default async function ProvidersPage({ searchParams }: PageProps<"/providers">) {
  const sp = await searchParams;
  const { supabase } = await getSession();
  const inv = await loadInventory(supabase);

  return (
    <>
      <PageHeader
        title="Providers"
        description="Connect cloud accounts with read-only access. Limit Gauge discovers what you can see and collects usage on a schedule."
        actions={<LinkButton href="/providers/resources">All resources</LinkButton>}
      />
      <Flash ok={sp.ok} error={sp.error} />

      <Card className="mb-6">
        <CardHeader title="Connections" description={`${inv.connections.length} connection${inv.connections.length === 1 ? "" : "s"}`} />
        {inv.connections.length === 0 ? (
          <EmptyState icon={<Cloud className="size-8" />} title="No providers connected yet">
            Connect Supabase below to discover your organizations and projects.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {inv.connections.map((c) => {
              const resources = inv.resources.filter((r) => r.connection_id === c.id);
              const monitored = resources.filter((r) => r.is_monitored && r.status === "active").length;
              return (
                <li key={c.id}>
                  <Link href={`/providers/${c.id}`} className="flex flex-col gap-2 px-4 py-3 hover:bg-surface-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-medium text-text">
                        {c.label}
                        <span className="text-xs font-normal text-muted">{PROVIDER_NAMES[c.provider]}</span>
                        {c.provider === "demo" ? <Badge tone="demo">Demo data</Badge> : null}
                      </p>
                      <p className="mt-0.5 text-xs text-muted">
                        {monitored} of {resources.length} resources monitored · last successful sync <TimeAgo iso={c.last_success_at} />
                        {c.status_detail && c.status !== "connected" ? <> · {c.status_detail}</> : null}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <ConnectionStatusBadge status={c.status} syncing={isSyncing(c)} />
                      <ArrowRight className="size-4 text-faint" aria-hidden />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <h2 className="mb-3 text-sm font-semibold">Add a connection</h2>
      {PROVIDER_CATEGORIES.map((category) => (
        <section key={category.id} className="mb-6" aria-labelledby={`category-${category.id}`}>
          <h3 id={`category-${category.id}`} className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
            {category.name}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {PROVIDER_CATALOG.filter((p) => p.category === category.id).map((p) => (
              <Card key={p.id} className="flex flex-col p-4">
                <div className="flex items-center justify-between">
                  <p className="font-medium">{p.name}</p>
                  {p.available ? <Badge tone="ok">Available</Badge> : <Badge>Coming soon</Badge>}
                </div>
                <p className="mt-1 flex-1 text-sm text-muted">{p.description}</p>
                <div className="mt-3">
                  {p.available ? (
                    <LinkButton href={`/providers/connect/${p.id}`} variant="primary" size="sm">
                      Connect {p.name}
                    </LinkButton>
                  ) : (
                    <span className="text-xs text-faint">Not available yet</span>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </section>
      ))}
      {demoEnabled() ? (
        <section className="mb-6" aria-labelledby="category-development">
          <h3 id="category-development" className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
            Development
          </h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Card className="flex flex-col border-dashed p-4">
              <div className="flex items-center justify-between">
                <p className="flex items-center gap-1.5 font-medium">
                  <FlaskConical className="size-4 text-demo" aria-hidden /> Demo Cloud
                </p>
                <Badge tone="demo">Development only</Badge>
              </div>
              <p className="mt-1 flex-1 text-sm text-muted">
                Generated sample organizations and projects with 35 days of history, so you can explore forecasts and alerts without
                credentials. Always labelled as demo data.
              </p>
              <form action={connectDemo} className="mt-3">
                <SubmitButton size="sm" variant="secondary" pendingText="Connecting…">
                  Add demo connection
                </SubmitButton>
              </form>
            </Card>
          </div>
        </section>
      ) : null}
    </>
  );
}
