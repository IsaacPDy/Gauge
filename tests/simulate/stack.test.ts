import { describe, expect, it } from "vitest";
import { FIREBASE_BACKEND_REASON, NO_SUPABASE_REASON, resolveStack } from "@/lib/engine/simulate/stack";
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

  it("says when the cache is dropped because Supabase is off, but not for a direct host", () => {
    const noDb = resolveStack(inputsWith({ cache: "upstash_payg", supabase: "off" }));
    expect(noDb.notices).toEqual(["The cache is modelled in front of a Supabase database, so it isn't priced while Supabase is off."]);

    const direct = resolveStack(inputsWith({ cache: "upstash_payg", host: "direct" }));
    expect(direct.notices).toEqual([]);
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

  it("uses Firebase as the database when it is the only backend, and moves files to it", () => {
    const { stack, notices } = resolveStack(inputsWith({ supabase: "off", firebase: "blaze" }));
    expect(stack).toMatchObject({ supabase: null, firebase: "blaze", backend: "firebase", fileStore: "firebase", host: "vercel" });
    expect(notices).toEqual(["Supabase is off, so files are stored in Cloud Storage for Firebase."]);
  });

  it("follows db when both backends are on, keeping the other for files", () => {
    const { stack, notices } = resolveStack(inputsWith({ firebase: "blaze", db: "firebase" }));
    expect(stack).toMatchObject({ supabase: "pro", firebase: "blaze", backend: "firebase", fileStore: "supabase" });
    expect(notices).toEqual([]);
  });

  it("ignores db when it names a backend that is off", () => {
    expect(resolveStack(inputsWith({ db: "firebase" })).stack.backend).toBe("supabase");
    expect(resolveStack(inputsWith({ supabase: "off", firebase: "off" })).stack.backend).toBeNull();
  });

  it("doesn't price a second backend that nothing uses", () => {
    const fb = resolveStack(inputsWith({ firebase: "spark" }));
    expect(fb.stack.firebase).toBeNull();
    expect(fb.notices).toEqual(["Firebase is on, but Supabase is the database and nothing else uses it, so it isn't priced."]);

    const sb = resolveStack(inputsWith({ firebase: "blaze", db: "firebase", fileStore: "firebase" }));
    expect(sb.stack.supabase).toBeNull();
    expect(sb.notices).toEqual(["Supabase is on, but Firebase is the database and nothing else uses it, so it isn't priced."]);
  });

  it("uses Supabase Storage when Cloud Storage for Firebase is picked without Firebase", () => {
    const { stack, notices } = resolveStack(inputsWith({ fileStore: "firebase" }));
    expect(stack.fileStore).toBe("supabase");
    expect(notices).toEqual(["Cloud Storage for Firebase needs Firebase, so Supabase Storage is used."]);
  });

  it("falls back from R2 to the backend's own file storage", () => {
    const { stack, notices } = resolveStack(inputsWith({ supabase: "off", firebase: "blaze", fileStore: "r2" }));
    expect(stack.fileStore).toBe("firebase");
    expect(notices).toEqual(["R2 file storage needs Cloudflare, so Cloud Storage for Firebase is used."]);
  });

  it("doesn't price the cache in front of Firebase", () => {
    const { stack, notices } = resolveStack(inputsWith({ supabase: "off", firebase: "blaze", fileStore: "firebase", cache: "upstash_payg" }));
    expect(stack.cache).toBe(false);
    expect(stack.cacheBlockedReason).toBe(FIREBASE_BACKEND_REASON);
    expect(notices).toEqual(["The cache is modelled in front of a Supabase database, so it isn't priced while Firebase is the database."]);
  });

  it("names the backend when the client calls it directly", () => {
    const { stack, notices } = resolveStack(inputsWith({ supabase: "off", firebase: "blaze", fileStore: "firebase", vercel: "off" }));
    expect(stack.host).toBe("direct");
    expect(notices).toEqual(["Vercel is turned off, so the client calls Firebase directly."]);
  });
});
