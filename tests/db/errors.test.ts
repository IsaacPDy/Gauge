import { describe, expect, it } from "vitest";
import { dbErrorMessage, friendlyDbError, isUniqueViolation } from "../../src/db/errors";

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

  it("keeps a plain Error's own message even when it has a cause", () => {
    const e = new Error("outer message", { cause: driverError() });
    expect(dbErrorMessage(e)).toBe("outer message");
  });

  it("falls back to the cause name when its message is empty (AggregateError)", () => {
    const e = new FakeDrizzleQueryError("Failed query: select 1\nparams: secret", { cause: new AggregateError([], "") });
    expect(dbErrorMessage(e)).toBe("AggregateError");
  });

  it("recognises a DrizzleQueryError by name even when the message does not start with Failed query", () => {
    const e = new FakeDrizzleQueryError("select 1 params: secret", { cause: new Error("boom") });
    e.name = "DrizzleQueryError";
    expect(dbErrorMessage(e)).toBe("boom");
  });

  it('returns "Database error" for a failed query without a usable cause', () => {
    expect(dbErrorMessage(new FakeDrizzleQueryError("Failed query: select 1\nparams: secret"))).toBe("Database error");
    expect(dbErrorMessage(new FakeDrizzleQueryError("Failed query: select 1\nparams: secret", { cause: "text" }))).toBe("Database error");
  });
});

describe("friendlyDbError", () => {
  const withCode = (code: string, message = "secret detail: table users column email") =>
    new FakeDrizzleQueryError("Failed query: select 1\nparams: secret", { cause: Object.assign(new Error(message), { code }) });

  it("maps known SQLSTATEs to fixed user text, whether wrapped by Drizzle or not", () => {
    expect(friendlyDbError(withCode("23505"))).toBe("That already exists.");
    expect(friendlyDbError(Object.assign(new Error("dup"), { code: "23503" }))).toBe("That item no longer exists or belongs to another workspace.");
    for (const code of ["23514", "22P02", "22007", "22023"]) {
      expect(friendlyDbError(withCode(code))).toBe("One of the values is not allowed.");
    }
    expect(friendlyDbError(withCode("22001"))).toBe("One of the values is too long.");
  });

  it("never leaks the driver message, SQL or parameters", () => {
    for (const code of ["23505", "42P01", "XX000"]) {
      const text = friendlyDbError(withCode(code));
      expect(text).not.toContain("secret");
      expect(text).not.toContain("Failed query");
    }
  });

  it("uses the default or the given fallback for anything else", () => {
    expect(friendlyDbError(withCode("42P01"))).toBe("Something went wrong. Try again in a moment.");
    expect(friendlyDbError(new Error("boom"))).toBe("Something went wrong. Try again in a moment.");
    expect(friendlyDbError(null, "Custom.")).toBe("Custom.");
  });
});
