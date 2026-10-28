import { afterEach, describe, expect, it, vi } from "vitest";
import { appUrl, safeNext } from "@/lib/urls";

const ORIGIN = "http://app.test";
const hostile: unknown[] = [
  "//x", "//evil.com", "/\\x", "/\\evil.com", "/\t/x", "/\n/evil.com", "/\r/evil.com", "/\u0000/x", "/\u007f/x",
  "/%2F%2Fx", "/..//x", "/../../x", "", undefined, null, 0, 42, {}, [], "https://evil.com", "http://evil.com/home",
  "javascript:alert(1)", "evil.com", "home", " /home", "\\\\evil.com",
];

describe("safeNext", () => {
  it.each(["//x", "/\\x", "/\t/x", "/\n/x", "/\r/x", "https://evil.com", "javascript:alert(1)", "", "home"])("falls back for %j", (input) => {
    expect(safeNext(input)).toBe("/home");
  });

  it.each([undefined, null, 0, 42, {}, []])("falls back for non-string %j", (input) => {
    expect(safeNext(input)).toBe("/home");
  });

  it("always resolves to the same origin", () => {
    for (const input of hostile) {
      const result = safeNext(input);
      expect(new URL(result, ORIGIN).origin, `input ${JSON.stringify(input)} -> ${result}`).toBe(ORIGIN);
    }
  });

  it("returns normal paths unchanged", () => {
    expect(safeNext("/home")).toBe("/home");
    expect(safeNext("/alerts?tab=inbox#x")).toBe("/alerts?tab=inbox#x");
  });

  it("honours a custom fallback", () => {
    expect(safeNext("//x", "/login")).toBe("/login");
  });
});

describe("appUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses APP_URL and strips trailing slashes", () => {
    vi.stubEnv("APP_URL", "https://app.example.com//");
    expect(appUrl("/reset-password")).toBe("https://app.example.com/reset-password");
    expect(appUrl()).toBe("https://app.example.com");
  });

  it("falls back to the dev server outside production", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(appUrl("/x")).toBe("http://localhost:3100/x");
  });

  it("throws in production when APP_URL is unset", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => appUrl("/x")).toThrow(/APP_URL/);
  });
});
