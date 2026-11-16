import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findSignedInvoice, type InvoiceCheck, type PayeeInfo } from "../../sdk/src/index.js";
import { heuristicClaims, stripInvoiceBlock } from "../src/claims.js";
import { decide, type SessionLimits } from "../src/policy.js";

const ex = (name: string) => readFileSync(new URL(`../examples/${name}`, import.meta.url), "utf8");
const NOW = 1_794_900_000;
const ok: InvoiceCheck = { verdict: "Payable", ok: true, at: 1n, message: "Payable." };
const oldPayee: PayeeInfo = { status: "Active", requestedAt: 1n, activeAt: 1n, revokedAt: 0n, approved: true };
const session = (over: Partial<SessionLimits> = {}): SessionLimits => ({
  active: true,
  token: "0x456569838f1d43009A91ebA4263147Afd7233483",
  perPaymentCap: 100_000n,
  dailyCap: 150_000n,
  spentToday: 0n,
  validUntil: NOW + 86_400,
  payeeAllowed: true,
  ...over,
});

describe("heuristic claims", () => {
  it("spots a bank-details change and urgency, and lists addresses from the text only", () => {
    const c = heuristicClaims(ex("fake.txt"));
    expect(c.mentionsBankDetailChange).toBe(true);
    expect(c.urgencyPressure).toBe(true);
    expect(c.addressesInText).toEqual([]); // the only address is inside the signed block, which is data
    expect(c.claimedAmount).toBe("0.05");
    expect(c.claimedBusinessName).toBe("Forela Ltd");
  });

  it("flags text aimed at the assistant (prompt injection)", () => {
    const c = heuristicClaims(ex("injection.txt"));
    expect(c.instructionsToAssistant.length).toBeGreaterThan(0);
    expect(c.addressesInText).toHaveLength(1);
  });

  it("ignores the signed block when reading claims", () => {
    expect(stripInvoiceBlock(ex("legit.txt"))).not.toMatch(/BEGIN PAYEEGUARD/);
  });
});

describe("decision", () => {
  it("pays a valid invoice within the session caps", () => {
    const signed = findSignedInvoice(ex("legit.txt"))!;
    const d = decide({ signed, check: ok, payee: oldPayee, claims: heuristicClaims(ex("legit.txt")), session: session(), now: NOW });
    expect(d.action).toBe("pay");
    expect(d.warnings).toEqual([]);
  });

  it("never pays an address that only appears in the email text", () => {
    const d = decide({ claims: heuristicClaims(ex("plain.txt")), now: NOW });
    expect(d.action).toBe("refuse");
    expect(d.reasons[0]).toMatch(/No signed PayeeGuard invoice/);
  });

  it("refuses whatever the chain refuses, with the chain's reason", () => {
    const signed = findSignedInvoice(ex("fake.txt"))!;
    const check: InvoiceCheck = { verdict: "PayeeInCoolingOff", ok: false, at: 2n, message: "Refused: cooling-off." };
    const d = decide({ signed, check, claims: heuristicClaims(ex("fake.txt")), session: session(), now: NOW });
    expect(d).toMatchObject({ action: "refuse", reasons: ["Refused: cooling-off."] });
  });

  it("pays the signed payee, not the one the injected text names, and says so", () => {
    const signed = findSignedInvoice(ex("injection.txt"))!;
    const d = decide({ signed, check: ok, payee: oldPayee, claims: heuristicClaims(ex("injection.txt")), session: session(), now: NOW });
    expect(d.action).toBe("pay");
    expect(d.warnings.join(" ")).toMatch(/prompt injection/);
    expect(d.warnings.join(" ")).toMatch(/ignored\. The payee comes only from the signed invoice/);
  });

  it("asks the owner above the per-payment cap", () => {
    const signed = findSignedInvoice(ex("big.txt"))!;
    const d = decide({ signed, check: ok, payee: oldPayee, claims: heuristicClaims(ex("big.txt")), session: session(), now: NOW });
    expect(d.action).toBe("ask_owner");
    expect(d.reasons[0]).toMatch(/above the assistant's per-payment cap/);
  });

  it("asks the owner when the email claims new bank details for a recently activated address", () => {
    const signed = findSignedInvoice(ex("legit.txt"))!;
    const claims = { ...heuristicClaims(ex("legit.txt")), mentionsBankDetailChange: true };
    const fresh: PayeeInfo = { ...oldPayee, activeAt: BigInt(NOW - 3600) };
    expect(decide({ signed, check: ok, payee: fresh, claims, session: session(), now: NOW }).action).toBe("ask_owner");
  });

  it("asks the owner when the email amount disagrees with the signed amount", () => {
    const signed = findSignedInvoice(ex("legit.txt"))!;
    const claims = { ...heuristicClaims(ex("legit.txt")), claimedAmount: "5.00" };
    expect(decide({ signed, check: ok, payee: oldPayee, claims, session: session(), now: NOW }).reasons[0]).toMatch(/email says 5.00/);
  });

  it("asks the owner when the session is revoked, over the daily cap, or not allowed for this payee", () => {
    const signed = findSignedInvoice(ex("legit.txt"))!;
    const claims = heuristicClaims(ex("legit.txt"));
    for (const s of [session({ active: false }), session({ spentToday: 120_000n }), session({ payeeAllowed: false })]) {
      expect(decide({ signed, check: ok, payee: oldPayee, claims, session: s, now: NOW }).action).toBe("ask_owner");
    }
  });
});
