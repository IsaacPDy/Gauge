import { PageHeader } from "@/components/ui";
import { decode } from "@/lib/engine/simulate/inputs";
import { CompareView } from "./compare-view";

export const metadata = { title: "Compare plans" };

export default async function ComparePage({ searchParams }: PageProps<"/simulator/compare">) {
  // The view reads the scenario from the URL itself; the server decode supplies the
  // notices for the first render.
  const { notices } = decode(await searchParams);
  return (
    <>
      <PageHeader
        title="Compare plans"
        description="Every plan of every service against the same workload: how close it gets to each limit, and what it costs. Nothing here reads your connected accounts."
      />
      {/* One clock for server and client, so price staleness can't differ across hydration. */}
      <CompareView initialNotices={notices} now={new Date().toISOString()} />
    </>
  );
}
