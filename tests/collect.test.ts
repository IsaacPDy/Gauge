import { describe, expect, it } from "vitest";
import { dayObservation, emptyResult, recordFailure, recordOk, recordUnsupported, utcDays } from "@/lib/providers/collect";
import { requestJson, requestText } from "@/lib/providers/http";
import { ProviderError } from "@/lib/providers/types";

const now = new Date("2026-10-09T12:00:00Z");
const scope = { resourceExternalId: "r1" };
const respond = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;

describe("requestText / requestJson", () => {
  it("returns raw text, maps errors and still parses JSON", async () => {
    await expect(requestText("https://x.test/a", { fetch: respond(200, '{"a":1}\n{"a":2}\n') })).resolves.toBe('{"a":1}\n{"a":2}\n');
    await expect(requestText("https://x.test/a", { fetch: respond(403, "nope") })).rejects.toMatchObject({ code: "permission_denied" });
    await expect(requestJson("https://x.test/a", { fetch: respond(200, '{"ok":true}') })).resolves.toEqual({ ok: true });
    await expect(requestJson("https://x.test/a", { fetch: respond(200, "{oops") })).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("collect helpers", () => {
  it("lists UTC days inclusively", () => {
    expect(utcDays(new Date("2026-10-07T18:00:00Z"), now).map((d) => d.toISOString().slice(0, 10))).toEqual([
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
    ]);
  });

  it("marks today's daily bucket partial unless told otherwise", () => {
    expect(dayObservation("m", scope, new Date("2026-10-08T05:00:00Z"), 3, now).quality).toBe("ok");
    expect(dayObservation("m", scope, now, 3, now).quality).toBe("partial");
    expect(dayObservation("m", scope, now, 3, now, { quality: "ok", source: "derived" })).toMatchObject({
      quality: "ok",
      source: "derived",
      bucketStart: new Date("2026-10-09T00:00:00Z"),
      bucketEnd: new Date("2026-10-10T00:00:00Z"),
    });
  });

  it("records permission errors as unavailable, others as error, and rethrows auth failures", () => {
    const r = emptyResult();
    recordFailure(r, ["a", "b"], [scope], new ProviderError("permission_denied", "no"));
    recordFailure(r, ["c"], [scope], new ProviderError("invalid_response", "bad"));
    expect(r.outcomes.map((o) => [o.metricKey, o.status, o.errorCode])).toEqual([
      ["a", "unavailable", "permission_denied"],
      ["b", "unavailable", "permission_denied"],
      ["c", "error", "invalid_response"],
    ]);
    expect(() => recordFailure(r, ["a"], [scope], new ProviderError("auth_invalid", "revoked"))).toThrow("revoked");
  });

  it("records ok and unsupported outcomes", () => {
    const r = emptyResult();
    recordOk(r, ["a"], [scope]);
    recordUnsupported(r, [{ key: "u", supported: false, unsupportedReason: "why" } as never], scope);
    expect(r.outcomes).toEqual([
      { metricKey: "a", scope, status: "ok" },
      { metricKey: "u", scope, status: "unsupported", detail: "why" },
    ]);
  });
});
