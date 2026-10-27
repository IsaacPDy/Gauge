import { PageHeader } from "@/components/ui";
import { decode } from "@/lib/engine/simulate/inputs";
import { SimulatorView } from "./simulator-view";

export const metadata = { title: "Cost simulator" };

export default async function SimulatorPage({ searchParams }: PageProps<"/simulator">) {
  const { inputs, notices } = decode(await searchParams);
  return (
    <>
      <PageHeader
        title="Cost simulator"
        description="Estimate what your stack costs for a workload you describe. Nothing here reads your connected accounts."
      />
      <SimulatorView initialInputs={inputs} initialNotices={notices} />
    </>
  );
}
