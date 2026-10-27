import { describe, expect, it } from "vitest";
import { resolveStack } from "@/lib/engine/simulate/stack";
import { inputsWith } from "./fixtures";

describe("resolveStack", () => {
  it("keeps a valid stack as is", () => {
    const { stack, notices } = resolveStack(inputsWith());
    expect(stack).toMatchObject({ supabase: "pro", vercel: "pro", cloudflare: null, host: "vercel", fileStore: "supabase", cache: false });
    expect(notices).toEqual([]);
  });

  it("moves the API host to the first enabled service", () => {
    const { stack, notices } = resolveStack(inputsWith({ vercel: "off", cloudflare: "paid", host: "vercel" }));
    expect(stack.host).toBe("cloudflare");
    expect(notices).toHaveLength(1);
  });

  it("falls back to direct when no server host is on", () => {
    const { stack, notices } = resolveStack(inputsWith({ vercel: "off", host: "vercel" }));
    expect(stack.host).toBe("direct");
    expect(notices).toHaveLength(1);
  });

  it("uses Supabase Storage when R2 is picked without Cloudflare", () => {
    const { stack, notices } = resolveStack(inputsWith({ fileStore: "r2" }));
    expect(stack.fileStore).toBe("supabase");
    expect(notices).toHaveLength(1);
  });

  it("prices the cache only behind a server host and in front of Supabase", () => {
    expect(resolveStack(inputsWith({ cache: "upstash_payg" })).stack.cache).toBe(true);

    const direct = resolveStack(inputsWith({ cache: "upstash_payg", host: "direct" })).stack;
    expect(direct.cache).toBe(false);
    expect(direct.cacheBlockedReason).toMatch(/server-side/);

    const noDb = resolveStack(inputsWith({ cache: "upstash_payg", supabase: "off" })).stack;
    expect(noDb.cache).toBe(false);
    expect(noDb.cacheBlockedReason).toMatch(/Supabase/);
  });
});
