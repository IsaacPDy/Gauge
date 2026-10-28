import { describe, expect, it } from "vitest";
import { dbErrorMessage, isUniqueViolation } from "../../src/db/errors";

// Mimics DrizzleQueryError: the message embeds the SQL and the bound parameters.
class FakeDrizzleQueryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

const driverError = () =>
  Object.assign(new Error('duplicate key value violates unique constraint "x"'), { code: "23505" });

describe("dbErrorMessage", () => {
  it("keeps the SQLSTATE and driver message but never the SQL or bound parameters", () => {
    const e = new FakeDrizzleQueryError("Failed query: insert into t (c) values ($1)\nparams: secret", { cause: driverError() });
    const msg = dbErrorMessage(e);
    expect(msg).toContain("23505");
    expect(msg).toContain('duplicate key value violates unique constraint "x"');
    expect(msg).not.toContain("params");
    expect(msg).not.toContain("secret");
    expect(msg).not.toContain("Failed query");
    expect(isUniqueViolation(e)).toBe(true);
  });

  it("returns just the cause message when the cause has no SQLSTATE", () => {
    const e = new FakeDrizzleQueryError("Failed query: select 1\nparams: secret", { cause: new Error("connection terminated") });
    expect(dbErrorMessage(e)).toBe("connection terminated");
  });

  it("passes a plain Error message through", () => {
    expect(dbErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error values", () => {
    expect(dbErrorMessage("nope")).toBe("nope");
    expect(dbErrorMessage(42)).toBe("42");
    expect(dbErrorMessage(null)).toBe("null");
  });

  it('returns "Database error" for a failed query without a usable cause', () => {
    expect(dbErrorMessage(new FakeDrizzleQueryError("Failed query: select 1\nparams: secret"))).toBe("Database error");
    expect(dbErrorMessage(new FakeDrizzleQueryError("Failed query: select 1\nparams: secret", { cause: "text" }))).toBe("Database error");
  });
});
