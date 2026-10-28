import { ExternalLink, Search } from "lucide-react";
import Link from "next/link";
import { AutoSubmitSelect, SubmitButton } from "@/components/form-controls";
import { TimeAgo } from "@/components/time";
import { Badge, Button, Card, Checkbox, EmptyState, Flash, Input, inputClass, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { loadInventory } from "@/lib/data/views";
import { PROVIDER_NAMES } from "@/lib/providers/registry";
import { getSession } from "@/lib/session";
import { assignResource, setMonitored } from "../actions";

export const metadata = { title: "Resources" };

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function ResourcesPage({ searchParams }: PageProps<"/providers/resources">) {
  const sp = await searchParams;
  const q = str(sp.q).trim().toLowerCase();
  const provider = str(sp.provider);
  const status = str(sp.status);
  const monitored = str(sp.monitored);
  const app = str(sp.app);

  const { scope } = await getSession();
  const inv = await loadInventory(scope);
  const rows = inv.resources.filter((r) => {
    const conn = inv.connectionById.get(r.connection_id);
    const account = inv.accountById.get(r.account_id ?? "");
    if (q && ![r.name, r.external_id, account?.name ?? "", conn?.label ?? ""].some((s) => s.toLowerCase().includes(q))) return false;
    if (provider && r.provider !== provider) return false;
    if (status && r.status !== status) return false;
    if (monitored === "yes" && !r.is_monitored) return false;
    if (monitored === "no" && r.is_monitored) return false;
    const a = inv.appByResource.get(r.id);
    if (app === "none" && a) return false;
    if (app && app !== "none" && a?.id !== app) return false;
    return true;
  });
  const providers = [...new Set(inv.resources.map((r) => r.provider))];
  const back = `/providers/resources?${new URLSearchParams(Object.entries({ q, provider, status, monitored, app }).filter(([, v]) => v)).toString()}`;

  return (
    <>
      <PageHeader
        title="Resources"
        description="Everything discovered across your connections. Choose what to monitor and group resources into applications. Provider hierarchy is kept as-is; applications are your own grouping."
      />
      <Flash ok={sp.ok} error={sp.error} />

      <Card className="mb-4 p-3">
        <form className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_auto_auto_auto_auto_auto]" role="search">
          <div className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-faint" aria-hidden />
            <label htmlFor="q" className="sr-only">
              Search resources
            </label>
            <Input id="q" name="q" defaultValue={q} placeholder="Search name, ID, organization…" className="pl-8" />
          </div>
          <Select name="provider" defaultValue={provider} aria-label="Provider">
            <option value="">All providers</option>
            {providers.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_NAMES[p] ?? p}
              </option>
            ))}
          </Select>
          <Select name="status" defaultValue={status} aria-label="Status">
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="inaccessible">Inaccessible</option>
            <option value="deleted">Deleted</option>
          </Select>
          <Select name="monitored" defaultValue={monitored} aria-label="Monitoring">
            <option value="">Monitored or not</option>
            <option value="yes">Monitored</option>
            <option value="no">Not monitored</option>
          </Select>
          <Select name="app" defaultValue={app} aria-label="Application">
            <option value="">Any application</option>
            <option value="none">Unassigned</option>
            {inv.applications.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          <Button type="submit">Filter</Button>
        </form>
      </Card>

      <Card>
        {rows.length === 0 ? (
          <EmptyState title={inv.resources.length ? "No resources match these filters" : "No resources discovered yet"}>
            {inv.resources.length ? null : (
              <>
                <Link href="/providers" className="text-accent hover:underline">
                  Connect a provider
                </Link>{" "}
                to discover resources.
              </>
            )}
          </EmptyState>
        ) : (
          <>
            <form id="bulk" action={setMonitored}>
              <input type="hidden" name="back" value={back} />
            </form>
            <Table>
              <thead>
                <tr>
                  <Th className="w-10">
                    <span className="sr-only">Select</span>
                  </Th>
                  <Th>Resource</Th>
                  <Th>Provider / organization</Th>
                  <Th>Status</Th>
                  <Th>Monitoring</Th>
                  <Th>Application</Th>
                  <Th>Last collected</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const conn = inv.connectionById.get(r.connection_id);
                  return (
                    <tr key={r.id}>
                      <Td>
                        <Checkbox form="bulk" name="ids" value={r.id} aria-label={`Select ${r.name}`} />
                      </Td>
                      <Td>
                        <span className="flex items-center gap-1.5 font-medium">
                          {r.name}
                          {r.dashboard_url ? (
                            <a href={r.dashboard_url} target="_blank" rel="noreferrer" aria-label={`Open ${r.name} in provider dashboard`} className="text-faint hover:text-accent">
                              <ExternalLink className="size-3" aria-hidden />
                            </a>
                          ) : null}
                        </span>
                        <span className="block font-mono text-[11px] text-faint">
                          {r.resource_type} · {r.external_id}
                        </span>
                      </Td>
                      <Td className="text-xs text-muted">
                        <Link href={`/providers/${r.connection_id}`} className="hover:underline">
                          {conn?.label}
                        </Link>
                        {conn?.provider === "demo" ? (
                          <Badge tone="demo" className="ml-1">
                            Demo
                          </Badge>
                        ) : null}
                        <span className="block">{inv.accountById.get(r.account_id ?? "")?.name ?? "—"}</span>
                      </Td>
                      <Td>{r.status === "active" ? <Badge tone="ok">Active</Badge> : <Badge tone="warn">{r.status}</Badge>}</Td>
                      <Td>{r.is_monitored ? <Badge tone="accent">Monitored</Badge> : <span className="text-xs text-faint">Not monitored</span>}</Td>
                      <Td>
                        <form action={assignResource}>
                          <input type="hidden" name="resourceId" value={r.id} />
                          <input type="hidden" name="back" value={back} />
                          <label htmlFor={`app-${r.id}`} className="sr-only">
                            Application for {r.name}
                          </label>
                          <AutoSubmitSelect id={`app-${r.id}`} name="applicationId" defaultValue={inv.appByResource.get(r.id)?.id ?? ""} className={`${inputClass} h-8 min-w-36 text-xs`}>
                            <option value="">Unassigned</option>
                            {inv.applications.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                          </AutoSubmitSelect>
                        </form>
                      </Td>
                      <Td className="text-xs text-muted">
                        <TimeAgo iso={r.last_collected_at} />
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3">
              <span className="text-xs text-muted">With selected:</span>
              <SubmitButton form="bulk" name="monitored" value="true" variant="secondary" size="sm">
                Monitor
              </SubmitButton>
              <SubmitButton form="bulk" name="monitored" value="false" variant="secondary" size="sm">
                Stop monitoring
              </SubmitButton>
            </div>
          </>
        )}
        {inv.applications.length === 0 && rows.length > 0 ? (
          <p className="border-t border-border px-4 py-3 text-xs text-muted">
            <Link href="/applications" className="text-accent hover:underline">
              Create an application
            </Link>{" "}
            to group resources that belong to the same product.
          </p>
        ) : null}
      </Card>
    </>
  );
}
