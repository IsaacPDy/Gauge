import { ExternalLink, KeyRound } from "lucide-react";
import { notFound } from "next/navigation";
import { Card, CardBody, CardHeader, Notice, PageHeader } from "@/components/ui";
import { tokenProvider } from "@/lib/providers/registry";
import { connectToken } from "../../actions";
import { TokenForm } from "../../token-form";

export async function generateMetadata({ params }: PageProps<"/providers/connect/[provider]">) {
  const adapter = tokenProvider((await params).provider);
  return { title: adapter ? `Connect ${adapter.name}` : "Connect a provider" };
}

export default async function ConnectTokenPage({ params }: PageProps<"/providers/connect/[provider]">) {
  const adapter = tokenProvider((await params).provider);
  const info = adapter?.tokenConnect;
  if (!adapter || !info) notFound();

  return (
    <>
      <PageHeader
        title={`Connect ${adapter.name}`}
        description={`Limit Gauge reads your ${adapter.name} projects and usage with an API token. It never changes anything in your account.`}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={`Create a ${info.tokenLabel.toLowerCase()}`} />
          <CardBody className="space-y-4">
            <ol className="list-decimal space-y-2 pl-5 text-sm text-text">
              {info.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            {info.permissions?.length ? (
              <div className="space-y-2">
                <p className="text-sm text-muted">Permissions to grant:</p>
                <ul className="flex flex-wrap gap-1.5">
                  {info.permissions.map((p) => (
                    <li key={p} className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-xs">
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <a href={info.createUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
              Open {adapter.name} token settings <ExternalLink className="size-3.5" aria-hidden />
            </a>
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-1.5">
                <KeyRound className="size-4 text-muted" aria-hidden /> {info.tokenLabel}
              </span>
            }
            description="Stored encrypted and never shown again after saving."
          />
          <CardBody className="space-y-4">
            {info.warning ? <Notice tone="warn">{info.warning}</Notice> : null}
            <TokenForm
              action={connectToken.bind(null, adapter.id)}
              withLabel
              defaultLabel={adapter.name}
              tokenLabel={info.tokenLabel}
              tokenHint={info.tokenHint ?? ""}
              placeholder={info.placeholder ?? ""}
              submit="Validate and connect"
            />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
