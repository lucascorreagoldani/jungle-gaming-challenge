import { describe, it, expect } from "bun:test";
import { canonicalizeJson, hashCanonicalPayload } from "../../../src/application/utils/canonical-json";

describe("Canonical JSON & Payload Hashing", () => {
  it("should produce identical canonical strings and hashes regardless of key order", () => {
    const payloadA = {
      providerId: "provider-a",
      externalTransactionId: "tx-123",
      playerId: "player-999",
      walletId: "wallet-456",
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    };

    const payloadB = {
      roundId: "round-1",
      money: { currency: "BRL", amount: "25.00" },
      gameId: "fortune-chimp",
      walletId: "wallet-456",
      playerId: "player-999",
      providerId: "provider-a",
      kind: "BET",
      externalTransactionId: "tx-123",
    };

    const canonicalA = canonicalizeJson(payloadA);
    const canonicalB = canonicalizeJson(payloadB);

    expect(canonicalA).toBe(canonicalB);

    const hashA = hashCanonicalPayload(payloadA);
    const hashB = hashCanonicalPayload(payloadB);

    expect(hashA).toBe(hashB);
  });

  it("should produce different hashes when payload values differ", () => {
    const payloadA = {
      providerId: "provider-a",
      amount: "25.00",
    };

    const payloadB = {
      providerId: "provider-a",
      amount: "50.00",
    };

    expect(hashCanonicalPayload(payloadA)).not.toBe(hashCanonicalPayload(payloadB));
  });
});
