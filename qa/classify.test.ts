import { describe, expect, test } from "bun:test";
import {
  backoffFor,
  classifyError,
  DEFAULT_TRANSIENT_BACKOFF_MS,
  parseDuration,
  parseResetHint,
} from "../src/classify";

describe("classifyError — transient", () => {
  test("529 endpoint unavailable", () => {
    expect(classifyError('529: {"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}'))
      .toBe("transient");
  });
  test("overloaded is transient, not a bounce", () => {
    expect(classifyError("Error: 529 overloaded_error")).toBe("transient");
    expect(classifyError("The model is overloaded, please try again")).toBe("transient");
  });
  test("5xx statuses", () => {
    for (const s of [500, 502, 503, 504, 529]) expect(classifyError(`HTTP ${s}`)).toBe("transient");
  });
  test("timeouts and transport errors", () => {
    for (const t of ["request timed out", "ETIMEDOUT", "ECONNRESET", "socket hang up", "fetch failed", "connection reset by peer"])
      expect(classifyError(t)).toBe("transient");
  });
  test("429 without quota/usage wording is transient", () => {
    expect(classifyError("HTTP 429: too many requests", { status: 429 })).toBe("transient");
    expect(classifyError("429 rate limit exceeded")).toBe("transient");
  });
});

describe("classifyError — quota", () => {
  test("429 with usage wording", () => {
    expect(classifyError('{"message":"Codex error: The usage limit has been reached","type":"usage_limit_reached"}', { status: 429 }))
      .toBe("quota");
  });
  test("402 and prepayment", () => {
    expect(classifyError("402 prepayment credits are depleted")).toBe("quota");
  });
  test("403 with usage wording", () => {
    expect(classifyError("insufficient_quota: you have exhausted your quota", { status: 403 })).toBe("quota");
  });
  test("resource exhausted / go usage limit", () => {
    expect(classifyError('429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}')).toBe("quota");
  });
  test("bare 403 without usage wording is fatal", () => {
    expect(classifyError("403 forbidden", { status: 403 })).toBe("fatal");
  });
});

describe("classifyError — fatal", () => {
  test("context overflow never bounces", () => {
    for (const t of ["maximum context length is 8192 tokens", "prompt is too long", "reduce the length of the messages"])
      expect(classifyError(t)).toBe("fatal");
  });
  test("auth and bad request", () => {
    expect(classifyError("401 unauthorized", { status: 401 })).toBe("fatal");
    expect(classifyError("invalid api key")).toBe("fatal");
    expect(classifyError("model not found")).toBe("fatal");
    expect(classifyError("")).toBe("fatal");
  });
  test("unrecognised text is fatal (no bounce)", () => {
    expect(classifyError("something odd happened")).toBe("fatal");
  });
});

describe("parseResetHint", () => {
  test("retry-after seconds header", () => {
    expect(parseResetHint("", { "retry-after": "120" })).toBe(120_000);
  });
  test("retry-after HTTP date header", () => {
    const when = new Date(Date.now() + 60_000).toUTCString();
    const hint = parseResetHint("", { "retry-after": when })!;
    expect(hint).toBeGreaterThan(50_000);
    expect(hint).toBeLessThanOrEqual(60_000);
  });
  test("relative phrasing", () => {
    expect(parseResetHint("Rate limit reached. Try again in 45 seconds.")).toBe(45_000);
    expect(parseResetHint("usage limit reached, resets in 4h12m")).toBe(4 * 3_600_000 + 12 * 60_000);
  });
  test("rolling window", () => {
    expect(parseResetHint("You have hit your 5-hour limit for gpt-6-sol")).toBe(5 * 3_600_000);
  });
  test("epoch field", () => {
    const ts = Math.floor(Date.now() / 1000) + 300;
    const hint = parseResetHint(`{"reset_at":${ts}}`)!;
    expect(hint).toBeGreaterThan(280_000);
    expect(hint).toBeLessThanOrEqual(300_000);
  });
  test("clock time rolls to tomorrow when in the past", () => {
    const past = new Date(Date.now() - 2 * 3_600_000);
    const hh = String(past.getHours()).padStart(2, "0");
    const hint = parseResetHint(`resets at ${hh}:00`)!;
    expect(hint).toBeGreaterThan(21 * 3_600_000);
  });
  test("no hint", () => {
    expect(parseResetHint("the usage limit has been reached")).toBeNull();
  });
});

describe("parseDuration / backoffFor", () => {
  test("compound durations", () => {
    expect(parseDuration("2h15m")).toBe(2 * 3_600_000 + 15 * 60_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("nothing here")).toBeNull();
  });
  test("default schedule is ~15s/60s/180s", () => {
    expect(DEFAULT_TRANSIENT_BACKOFF_MS).toEqual([15_000, 60_000, 180_000]);
    expect(backoffFor(1)).toBe(15_000);
    expect(backoffFor(2)).toBe(60_000);
    expect(backoffFor(3)).toBe(180_000);
    expect(backoffFor(9)).toBe(180_000);
  });
  test("configurable schedule and clamping", () => {
    expect(backoffFor(1, [100, 200])).toBe(100);
    expect(backoffFor(2, [100, 200])).toBe(200);
    expect(backoffFor(5, [100, 200])).toBe(200);
    expect(backoffFor(1, [])).toBe(0);
  });
});
