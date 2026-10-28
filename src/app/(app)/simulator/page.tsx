import { PageHeader } from "@/components/ui";
import { decode } from "@/lib/engine/simulate/inputs";
import { SimulatorView } from "./simulator-view";

export const metadata = { title: "Cost simulator" };

export default async function SimulatorPage({ searchParams }: PageProps<"/simulator">) {
  // The view reads the scenario from the URL itself; the server decode supplies the
  // notices for the first render.
  const { notices } = decode(await searchParams);
  return (
    <>
      <PageHeader
        title="Cost simulator"
        description="Estimate what your stack costs for a workload you describe. Nothing here reads your connected accounts."
      />
      {/* One clock for server and client, so price staleness can't differ across hydration. */}
      <SimulatorView initialNotices={notices} now={new Date().toISOString()} />
    </>
  );
}
