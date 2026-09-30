import { describe, expect, test } from "bun:test";
import { chainIndex, findNextModel, findPreferredModel, modelKey, type ChainModel } from "../src/chain";
import { markFailure, type FailureLedger } from "../src/cooldown";

const CHAIN: ChainModel[] = [
  { provider: "opencode-go", id: "space-bunny-free" },
  { provider: "opencode-go", id: "mimo-v2.6-pro" },
  { provider: "openai-codex", id: "gpt-6-sol" },
  { provider: "opencode-go", id: "glm-5.3-flash" },
  { provider: "opencode-go", id: "mimo-v2.6-flash" },
  { provider: "opencode-go", id: "longcat-2.5-preview-free" },
];
const COOLDOWN = 300_000;

function ledger(): FailureLedger { return { failures: new Map(), cooldowns: new Map() }; }
function cool(l: FailureLedger, key: string, ms = COOLDOWN) { markFailure(l, key, Date.now(), ms); }

describe("findNextModel — chain order", () => {
  test("mimo (2nd) fails → gpt-6-sol (3rd), not space-bunny (1st)", () => {
    const l = ledger();
    cool(l, "opencode-go/mimo-v2.6-pro");
    expect(modelKey(findNextModel(CHAIN, l, { failedKey: "opencode-go/mimo-v2.6-pro", fallbackCooldownMs: COOLDOWN })!))
      .toBe("openai-codex/gpt-6-sol");
  });
  test("wraps to the head after the last model", () => {
    const l = ledger();
    cool(l, "opencode-go/longcat-2.5-preview-free");
    expect(modelKey(findNextModel(CHAIN, l, { failedKey: "opencode-go/longcat-2.5-preview-free", fallbackCooldownMs: COOLDOWN })!))
      .toBe("opencode-go/space-bunny-free");
  });
  test("skips cooling models in order", () => {
    const l = ledger();
    cool(l, "opencode-go/mimo-v2.6-pro");
    cool(l, "openai-codex/gpt-6-sol");
    expect(modelKey(findNextModel(CHAIN, l, { failedKey: "opencode-go/mimo-v2.6-pro", fallbackCooldownMs: COOLDOWN })!))
      .toBe("opencode-go/glm-5.3-flash");
  });
  test("returns null when every model is cooling", () => {
    const l = ledger();
    for (const m of CHAIN) cool(l, modelKey(m));
    expect(findNextModel(CHAIN, l, { failedKey: "opencode-go/mimo-v2.6-pro", fallbackCooldownMs: COOLDOWN })).toBeNull();
  });
  test("afterIndex resumes past a model that could not be set", () => {
    const l = ledger();
    cool(l, "opencode-go/mimo-v2.6-pro");
    cool(l, "openai-codex/gpt-6-sol"); // setModel failed → skip past it
    expect(modelKey(findNextModel(CHAIN, l, { failedKey: "opencode-go/mimo-v2.6-pro", afterIndex: 2, fallbackCooldownMs: COOLDOWN })!))
      .toBe("opencode-go/glm-5.3-flash");
  });
  test("unknown failed model starts at the head", () => {
    const l = ledger();
    expect(modelKey(findNextModel(CHAIN, l, { failedKey: "other/model", fallbackCooldownMs: COOLDOWN })!))
      .toBe("opencode-go/space-bunny-free");
  });
  test("expired cooldowns are not skipped", () => {
    const l = ledger();
    cool(l, "openai-codex/gpt-6-sol", 1); // 1ms cooldown
    expect(modelKey(findNextModel(CHAIN, l, {
      failedKey: "opencode-go/mimo-v2.6-pro", fallbackCooldownMs: COOLDOWN, now: Date.now() + 5,
    })!)).toBe("openai-codex/gpt-6-sol");
  });
});

describe("findPreferredModel — return to the original", () => {
  test("returns to the original model once it is out of cooldown", () => {
    const l = ledger();
    cool(l, "opencode-go/mimo-v2.6-pro", 1); // expired
    const target = findPreferredModel(CHAIN, l, {
      currentKey: "openai-codex/gpt-6-sol", originalKey: "opencode-go/mimo-v2.6-pro",
      fallbackCooldownMs: COOLDOWN, now: Date.now() + 5,
    });
    expect(modelKey(target!)).toBe("opencode-go/mimo-v2.6-pro");
  });
  test("does not return while the original is still cooling", () => {
    const l = ledger();
    cool(l, "opencode-go/mimo-v2.6-pro");
    cool(l, "opencode-go/space-bunny-free");
    expect(findPreferredModel(CHAIN, l, {
      currentKey: "openai-codex/gpt-6-sol", originalKey: "opencode-go/mimo-v2.6-pro", fallbackCooldownMs: COOLDOWN,
    })).toBeNull();
  });
  test("falls back to the earliest available model earlier in the chain", () => {
    const l = ledger();
    cool(l, "opencode-go/mimo-v2.6-pro"); // original still cooling
    const target = findPreferredModel(CHAIN, l, {
      currentKey: "opencode-go/glm-5.3-flash", originalKey: "opencode-go/mimo-v2.6-pro", fallbackCooldownMs: COOLDOWN,
    });
    expect(modelKey(target!)).toBe("opencode-go/space-bunny-free");
  });
  test("no candidate when the current model is already the head", () => {
    const l = ledger();
    expect(findPreferredModel(CHAIN, l, {
      currentKey: "opencode-go/space-bunny-free", originalKey: "opencode-go/space-bunny-free", fallbackCooldownMs: COOLDOWN,
    })).toBeNull();
  });
  test("original model outside the chain is still preferred", () => {
    const l = ledger();
    const target = findPreferredModel(CHAIN, l, {
      currentKey: "openai-codex/gpt-6-sol", originalKey: "kimi-coding/k3", fallbackCooldownMs: COOLDOWN,
    });
    expect(modelKey(target!)).toBe("kimi-coding/k3");
  });
});

describe("chainIndex", () => {
  test("finds positions", () => {
    expect(chainIndex(CHAIN, "openai-codex/gpt-6-sol")).toBe(2);
    expect(chainIndex(CHAIN, "nope/nope")).toBe(-1);
  });
});
