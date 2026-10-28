import { describe, expect, it } from "vitest";
import { pick } from "@/db/pick";

describe("pick", () => {
  it("copies listed own keys", () => {
    expect(pick({ a: 1, b: "x", c: true }, ["a", "b"])).toEqual({ a: 1, b: "x" });
  });

  it("keeps null but drops undefined", () => {
    const out = pick({ a: null, b: undefined, c: 0 } as { a: null; b: undefined; c: number }, ["a", "b", "c"]);
    expect(out).toEqual({ a: null, c: 0 });
    expect("b" in out).toBe(false);
  });

  it("ignores inherited and prototype keys", () => {
    const obj = Object.create({ inherited: 1 }) as { inherited?: number; own?: number };
    obj.own = 2;
    expect(pick(obj, ["inherited", "own"])).toEqual({ own: 2 });
    expect(pick({}, ["toString" as never, "constructor" as never, "__proto__" as never])).toEqual({});
  });

  it("drops keys that are not in the whitelist", () => {
    const smuggled = { name: "ok", owner_id: "evil" } as { name: string; owner_id: string };
    expect(pick(smuggled, ["name"])).toEqual({ name: "ok" });
  });

  it("returns an empty object when nothing matches", () => {
    expect(pick({ a: 1 } as { a: number; b?: number }, ["b"])).toEqual({});
    expect(Object.keys(pick({ a: 1 }, []))).toEqual([]);
  });
});
