import { formatUnits, type Address } from "viem";
import type { InvoiceCheck, PayeeInfo, SignedInvoice } from "../../sdk/src/index.js";
import type { Claims } from "./claims.js";

export type SessionLimits = {
  active: boolean;
  token: Address;
  perPaymentCap: bigint;
  dailyCap: bigint;
  spentToday: bigint;
  validUntil: number;
  payeeAllowed: boolean;
};

export type Decision = {
  action: "pay" | "refuse" | "ask_owner";
  reasons: string[];
  warnings: string[];
};

const RECENT_CHANGE = 7 * 86_400;

/**
 * The payment decision is deterministic. The LLM (if any) only produced `claims`; it can add warnings or force a
 * human approval, never a payment. Money moves only when the signed invoice passes InvoicePay's own check and the
 * session's caps would accept it anyway (the account enforces those again in validateUserOp).
 */
export function decide(input: {
  signed?: SignedInvoice;
  check?: InvoiceCheck;
  payee?: PayeeInfo;
  claims: Claims;
  session?: SessionLimits;
  now: number;
}): Decision {
  const { signed, check, payee, claims, session, now } = input;
  const warnings: string[] = [];

  if (claims.instructionsToAssistant.length) {
    warnings.push(
      `The email contains text aimed at an automated payer (possible prompt injection), ignored: "${claims.instructionsToAssistant[0].slice(0, 140)}"`,
    );
  }

  if (!signed) {
    return {
      action: "refuse",
      reasons: [
        "No signed PayeeGuard invoice in this email, so the payee cannot be confirmed. Addresses written in the email text are never paid. Ask the business for a signed invoice.",
      ],
      warnings,
    };
  }
  const inv = signed.invoice;

  const foreign = claims.addressesInText.filter((a) => a.toLowerCase() !== inv.payTo.toLowerCase());
  if (foreign.length) {
    warnings.push(`The email text names ${foreign.join(", ")}; ignored. The payee comes only from the signed invoice (${inv.payTo}).`);
  }

  if (!check) return { action: "refuse", reasons: ["The on-chain check did not run."], warnings };
  if (!check.ok) return { action: "refuse", reasons: [check.message], warnings };

  const reasonsToAsk: string[] = [];
  const amount = Number(formatUnits(inv.amount, 6));
  if (claims.claimedAmount && Math.abs(Number(claims.claimedAmount) - amount) > 1e-9) {
    reasonsToAsk.push(`The email says ${claims.claimedAmount} but the signed invoice is for ${amount}.`);
  }
  if (claims.mentionsBankDetailChange && payee && now - Number(payee.activeAt) < RECENT_CHANGE) {
    reasonsToAsk.push(
      "The email says payment details changed and this payout address became active less than 7 days ago. Confirm with the business by phone.",
    );
  }
  if (claims.urgencyPressure) warnings.push("The email pushes for urgency; PayeeGuard does not speed up for that.");

  if (!session?.active) reasonsToAsk.push("The assistant has no active session key on this account.");
  else {
    if (inv.token.toLowerCase() !== session.token.toLowerCase()) reasonsToAsk.push("The invoice token is not one this session may pay.");
    if (inv.amount > session.perPaymentCap) {
      reasonsToAsk.push(`${amount} tUSD8 is above the assistant's per-payment cap of ${formatUnits(session.perPaymentCap, 6)} tUSD8.`);
    }
    if (session.spentToday + inv.amount > session.dailyCap) {
      reasonsToAsk.push(`Paying would exceed today's cap of ${formatUnits(session.dailyCap, 6)} tUSD8.`);
    }
    if (!session.payeeAllowed) reasonsToAsk.push(`Business #${inv.payeeAgentId} is not on the assistant's payee allowlist.`);
    if (now > session.validUntil) reasonsToAsk.push("The assistant's session key has expired.");
  }

  if (reasonsToAsk.length) return { action: "ask_owner", reasons: reasonsToAsk, warnings };
  return { action: "pay", reasons: [check.message], warnings };
}
