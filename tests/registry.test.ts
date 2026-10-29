import { describe, expect, it } from "vitest";
import { PROVIDER_CATALOG, getAdapter, tokenProvider } from "@/lib/providers/registry";

describe("tokenProvider", () => {
  it("returns available adapters that accept tokens", () => {
    expect(tokenProvider("supabase")?.id).toBe("supabase");
  });

  it("rejects the demo provider, planned providers and unknown ids", () => {
    expect(tokenProvider("demo")).toBeNull();
    expect(tokenProvider("aws")).toBeNull();
    expect(tokenProvider("nope")).toBeNull();
  });

  it("every available catalog entry has an adapter", () => {
    for (const p of PROVIDER_CATALOG.filter((x) => x.available)) expect(getAdapter(p.id), p.id).not.toBeNull();
  });
});
