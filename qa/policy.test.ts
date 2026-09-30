import { describe, expect, test } from "bun:test";

import {
  isRecoveryStop,
  isStaleContinuation,
  nextPreferredOnModelSelect,
  shouldCancelRetriesOnInput,
  shouldScheduleRetryAfterSettle,
  type UserMessageRef,
} from "../src/policy";

describe("isStaleContinuation", () => {
  const parkedAt = 1_000;
  const content = "[pinball] mock/flaky-529 transient provider error (…). Same-model retry 1/3 …";

  test("no user messages after parking — fresh", () => {
    expect(isStaleContinuation(parkedAt, content, [])).toBe(false);
  });

  test("only older user messages — fresh", () => {
    const msgs: UserMessageRef[] = [{ timestamp: 500, text: "do the thing" }];
    expect(isStaleContinuation(parkedAt, content, msgs)).toBe(false);
  });

  test("pinball's own continuation (identical text) keeps it fresh", () => {
    const msgs: UserMessageRef[] = [{ timestamp: 2_000, text: content }];
    expect(isStaleContinuation(parkedAt, content, msgs)).toBe(false);
  });

  test("a newer, different user message makes it stale", () => {
    const msgs: UserMessageRef[] = [
      { timestamp: 500, text: "do the thing" },
      { timestamp: 2_000, text: "unrelated new prompt" },
    ];
    expect(isStaleContinuation(parkedAt, content, msgs)).toBe(true);
  });

  test("comparison trims whitespace", () => {
    const msgs: UserMessageRef[] = [{ timestamp: 2_000, text: `  ${content}\n` }];
    expect(isStaleContinuation(parkedAt, content, msgs)).toBe(false);
  });
});

describe("shouldCancelRetriesOnInput", () => {
  test("interactive input cancels scheduled retries", () => {
    expect(shouldCancelRetriesOnInput("interactive")).toBe(true);
  });

  test("extension and rpc input leave retries alone", () => {
    expect(shouldCancelRetriesOnInput("extension")).toBe(false);
    expect(shouldCancelRetriesOnInput("rpc")).toBe(false);
  });
});

describe("shouldScheduleRetryAfterSettle", () => {
  test("an aborted turn never schedules a retry", () => {
    expect(shouldScheduleRetryAfterSettle("aborted")).toBe(false);
  });

  test("completed, errored, and unknown turns keep the old behavior", () => {
    expect(shouldScheduleRetryAfterSettle("completed")).toBe(true);
    expect(shouldScheduleRetryAfterSettle("error")).toBe(true);
    expect(shouldScheduleRetryAfterSettle(null)).toBe(true);
  });
});

describe("isRecoveryStop", () => {
  test("success-family stop reasons mean the session recovered", () => {
    for (const r of ["stop", "toolUse", "length", "deferred", "STOP"]) {
      expect(isRecoveryStop(r)).toBe(true);
    }
  });

  test("error and abort stop reasons do not", () => {
    for (const r of ["error", "aborted", "", "tool_error"]) {
      expect(isRecoveryStop(r)).toBe(false);
    }
  });
});

describe("nextPreferredOnModelSelect", () => {
  test("pinball-initiated switch keeps the current preference", () => {
    // Bounces and return-to-preferred call pi.setModel themselves; the
    // model_select those calls emit must not move originalModel, or every
    // bounce would redefine "preferred" to the fallback model.
    expect(
      nextPreferredOnModelSelect({ selfInitiated: true, provider: "mock", id: "quota-429" }),
    ).toBeNull();
  });

  test("operator manual pick becomes the new preferred model", () => {
    expect(
      nextPreferredOnModelSelect({ selfInitiated: false, provider: "mock", id: "ok" }),
    ).toEqual({ provider: "mock", id: "ok" });
  });

  test("cycle and restore selections also become preferred", () => {
    // source "cycle" (keybind) and "restore" both express operator intent,
    // same as a manual /model pick.
    for (const id of ["gpt-5", "longcat-2.5-preview-free"]) {
      expect(nextPreferredOnModelSelect({ selfInitiated: false, provider: "opencode-go", id })).toEqual({
        provider: "opencode-go",
        id,
      });
    }
  });
});
