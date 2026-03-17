import { describe, expect, test } from "bun:test";
import {
  createStreamToken,
  parseStreamTokenStartedAt,
  parseStreamTokenValue,
} from "@/lib/chat-stream-token";

describe("chat stream token helpers", () => {
  test("encodes and decodes startedAt and run id", () => {
    const token = createStreamToken(12345, "run-1");

    expect(parseStreamTokenStartedAt(token)).toBe(12345);
    expect(parseStreamTokenValue(token)).toBe("run-1");
  });

  test("returns null for malformed tokens", () => {
    expect(parseStreamTokenStartedAt(null)).toBeNull();
    expect(parseStreamTokenStartedAt("missing-separator")).toBeNull();
    expect(parseStreamTokenValue(null)).toBeNull();
    expect(parseStreamTokenValue("12345:")).toBeNull();
  });
});
