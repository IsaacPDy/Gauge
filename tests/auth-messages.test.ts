import { describe, expect, it } from "vitest";
import { deleteAccountMessage, passwordChangeMessage } from "@/lib/auth/messages";

const REJECTED = "The new password was rejected. Choose a longer or less common password.";

describe("passwordChangeMessage", () => {
  it("reports a wrong current password for every code the SDK uses", () => {
    for (const [code, status] of [
      ["invalid_credentials", 401],
      ["INVALID_PASSWORD", 400],
      ["INVALID_EMAIL_OR_PASSWORD", 400],
    ] as const) {
      expect(passwordChangeMessage({ code, status, message: "whatever" })).toBe("Your current password is incorrect.");
    }
  });

  it("does not mistake a weak new password for a wrong current one", () => {
    expect(passwordChangeMessage({ code: "weak_password", status: 400, message: "Password too short" })).toBe("Password too short.");
    expect(passwordChangeMessage({ code: "PASSWORD_TOO_LONG", status: 400, message: "Password too long" })).toBe("Password too long.");
  });

  it("falls back to a fixed message when a 400 carries unreadable text", () => {
    expect(passwordChangeMessage({ status: 400, message: 'Failed query: update "account" params: $1' })).toBe(REJECTED);
    expect(passwordChangeMessage({ status: 400, message: '{"error":"x"}' })).toBe(REJECTED);
    expect(passwordChangeMessage({ code: "validation_failed", status: 422 })).toBe(REJECTED);
    expect(passwordChangeMessage({ status: 400, message: "x".repeat(300) })).toBe(REJECTED);
  });

  it("maps rate limiting and server failures", () => {
    expect(passwordChangeMessage({ status: 429 })).toBe("Too many attempts. Wait a minute and try again.");
    expect(passwordChangeMessage({ code: "over_request_rate_limit" })).toBe("Too many attempts. Wait a minute and try again.");
    for (const status of [500, 502, 503]) {
      expect(passwordChangeMessage({ status, message: "boom" })).toBe("Password change is temporarily unavailable. Try again in a moment.");
    }
    expect(passwordChangeMessage({ code: "INTERNAL_ERROR" })).toBe("Password change is temporarily unavailable. Try again in a moment.");
  });

  it("uses a generic message for anything else and never an empty one", () => {
    expect(passwordChangeMessage({ status: 403, message: "Forbidden" })).toBe("Could not change the password.");
    expect(passwordChangeMessage({})).toBe("Could not change the password.");
  });
});

describe("deleteAccountMessage", () => {
  it("asks for a fresh sign-in when the session is too old", () => {
    const text = "For security, sign in again and then retry deleting your account.";
    expect(deleteAccountMessage({ code: "SESSION_EXPIRED", status: 400, message: "x" })).toBe(text);
    expect(deleteAccountMessage({ status: 400, message: "Session expired. Re-authenticate to perform this action." })).toBe(text);
  });

  it("never shows the upstream message otherwise", () => {
    const text = "Could not delete the account. Try again in a moment.";
    expect(deleteAccountMessage({ status: 500, message: "internal detail" })).toBe(text);
    expect(deleteAccountMessage({})).toBe(text);
  });
});
