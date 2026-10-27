import { describe, expect, it } from "vitest";
import { clampField, decode, encode, NUMBER_FIELDS, presetInputs } from "@/lib/engine/simulate/inputs";

const params = (q: string) => Object.fromEntries(new URLSearchParams(q));

describe("presets", () => {
  it("returns independent copies", () => {
    const a = presetInputs("small_saas");
    a.planningQps.small = 5;
    a.mau = 1;
    expect(presetInputs("small_saas").planningQps.small).toBeUndefined();
    expect(presetInputs("small_saas").mau).toBe(10_000);
  });

  it("keeps every preset value inside its field range", () => {
    for (const p of ["side_project", "small_saas", "consumer_app"] as const) {
      const inputs = presetInputs(p);
      for (const f of NUMBER_FIELDS) {
        const v = inputs[f.name];
        if (v === null) continue;
        expect(clampField(f, v)).toBe(v);
      }
    }
  });
});

describe("decode", () => {
  it("defaults to the Small SaaS preset with no notices", () => {
    const { inputs, notices } = decode({});
    expect(inputs).toEqual(presetInputs("small_saas"));
    expect(notices).toEqual([]);
  });

  it("loads the named preset", () => {
    expect(decode({ p: "consumer_app" }).inputs).toEqual(presetInputs("consumer_app"));
  });

  it("falls back on an unknown preset with a notice", () => {
    const { inputs, notices } = decode({ p: "nope" });
    expect(inputs.preset).toBe("small_saas");
    expect(notices).toHaveLength(1);
  });

  it("applies and clamps numbers", () => {
    const { inputs, notices } = decode(params("mau=-5&dau=500&seats=2.7&dbq=1000000"));
    expect(inputs.mau).toBe(0);
    expect(inputs.dauPct).toBe(100);
    expect(inputs.seats).toBe(3);
    expect(inputs.dbQueriesOverride).toBe(1_000_000);
    expect(notices).toEqual([]);
  });

  it("ignores unparsable numbers, unknown keys and bad enum values, with a notice each", () => {
    const { inputs, notices } = decode(params("mau=abc&kb=&zzz=1&sb=enterprise"));
    expect(inputs.mau).toBe(10_000);
    expect(inputs.responseKB).toBe(10);
    expect(inputs.supabase).toBe("pro");
    expect(notices).toHaveLength(4);
  });

  it("reads planning QPS overrides for known sizes only", () => {
    const { inputs, notices } = decode(params("qps.small=999&qps.bogus=5"));
    expect(inputs.planningQps).toEqual({ small: 999 });
    expect(notices).toHaveLength(1);
  });

  it("uses the first value of a repeated key", () => {
    expect(decode({ mau: ["5", "6"] }).inputs.mau).toBe(5);
  });
});

describe("encode", () => {
  it("writes only the preset for unchanged inputs", () => {
    expect(encode(presetInputs("small_saas"))).toBe("p=small_saas");
  });

  it("is stable through decode", () => {
    const q = "p=side_project&mau=1234&g=3";
    expect(encode(decode(params(q)).inputs)).toBe(q);
  });

  it("round-trips edited inputs", () => {
    const inputs = presetInputs("consumer_app");
    inputs.supabase = "team";
    inputs.compute = "large";
    inputs.mau = 777_000;
    inputs.dbQueriesOverride = 5_000_000;
    inputs.hitPct = 92;
    inputs.planningQps.medium = 650;
    expect(decode(params(encode(inputs))).inputs).toEqual(inputs);
  });
});
