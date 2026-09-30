import { describe, expect, test } from "bun:test";

import { isRecoveryStop, nextPreferredOnModelSelect } from "../src/policy";

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
