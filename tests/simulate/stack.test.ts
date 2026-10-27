import { describe, expect, it } from "vitest";
import { NO_SUPABASE_REASON, resolveStack } from "@/lib/engine/simulate/stack";
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
    expect(notices[0]).toBe("Vercel is turned off, so the API runs on Cloudflare Workers.");
  });

  it("falls back to direct when no server host is on", () => {
    const { stack, notices } = resolveStack(inputsWith({ vercel: "off", host: "vercel" }));
    expect(stack.host).toBe("direct");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toBe("Vercel is turned off, so the client calls Supabase directly.");
  });

  it("uses Supabase Storage when R2 is picked without Cloudflare", () => {
    const { stack, notices } = resolveStack(inputsWith({ fileStore: "r2" }));
    expect(stack.fileStore).toBe("supabase");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toBe("R2 file storage needs Cloudflare, so Supabase Storage is used.");
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

  it("moves a direct host to Vercel when Supabase is off", () => {
    const { stack, notices } = resolveStack(inputsWith({ supabase: "off", host: "direct" }));
    expect(stack.host).toBe("vercel");
    expect(notices).toEqual(["Supabase is turned off, so the API runs on Vercel."]);
  });

  it("prefers Vercel over Cloudflare when falling back", () => {
    const { stack } = resolveStack(inputsWith({ cloudflare: "off", host: "cloudflare" }));
    expect(stack.host).toBe("vercel");
  });

  it("counts Cloudflare Free as enabled and keeps R2", () => {
    const { stack, notices } = resolveStack(inputsWith({ vercel: "off", cloudflare: "free", host: "cloudflare", fileStore: "r2" }));
    expect(stack).toMatchObject({ host: "cloudflare", fileStore: "r2", cloudflare: "free" });
    expect(notices).toEqual([]);
  });

  it("adds no host notice when every service is off", () => {
    const { stack, notices } = resolveStack(inputsWith({ supabase: "off", vercel: "off", cloudflare: "off", fileStore: "r2" }));
    expect(stack.host).toBe("direct");
    expect(notices).toEqual(["R2 file storage needs Cloudflare, and Supabase is off, so file storage isn't priced."]);
  });

  it("reports two fallbacks at once", () => {
    const { notices } = resolveStack(inputsWith({ vercel: "off", fileStore: "r2" }));
    expect(notices).toHaveLength(2);
  });

  it("blames the missing database first when Supabase is off and the host is direct", () => {
    const { stack } = resolveStack(inputsWith({ supabase: "off", vercel: "off", host: "direct", cache: "upstash_payg" }));
    expect(stack.cacheBlockedReason).toBe(NO_SUPABASE_REASON);
  });
});
