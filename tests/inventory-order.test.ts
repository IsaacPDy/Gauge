import { describe, expect, it } from "vitest";
import { sortByCreated, sortByName } from "@/lib/data/sort";

const rows = (...names: string[]) => names.map((name, i) => ({ name, id: String(i).padStart(2, "0") }));
const names = (r: { name: string }[]) => r.map((x) => x.name);

describe("sortByName", () => {
  it("ignores case", () => {
    expect(names(sortByName(rows("Zeta", "alpha", "Beta")))).toEqual(["alpha", "Beta", "Zeta"]);
  });

  it("puts accented letters next to their base letter", () => {
    expect(names(sortByName(rows("Zed", "Émile", "eagle", "Ångström", "apple")))).toEqual(["Ångström", "apple", "eagle", "Émile", "Zed"]);
  });

  it("orders numbers naturally", () => {
    expect(names(sortByName(rows("project 10", "project 2", "project 1")))).toEqual(["project 1", "project 2", "project 10"]);
  });

  it("breaks ties by id and does not mutate its input", () => {
    const input = [
      { name: "Same", id: "b" },
      { name: "same", id: "a" },
    ];
    const copy = [...input];
    expect(sortByName(input).map((r) => r.id)).toEqual(["a", "b"]);
    expect(input).toEqual(copy);
  });
});

describe("sortByCreated", () => {
  it("orders by created_at then id", () => {
    const sorted = sortByCreated([
      { created_at: "2026-10-02T00:00:00.000Z", id: "a" },
      { created_at: "2026-10-01T00:00:00.000Z", id: "z" },
      { created_at: "2026-10-01T00:00:00.000Z", id: "b" },
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["b", "z", "a"]);
  });
});
