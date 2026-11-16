import { decodeErrorResult, formatUnits, type Abi, type Hex } from "viem";
import { invoicePayAbi, payeeGuardAccountAbi, payeeRegistryAbi } from "./abis.js";
import { TUSD8_DECIMALS } from "./chain.js";

const entryPointErrors = [
  {
    type: "error",
    name: "FailedOp",
    inputs: [
      { name: "opIndex", type: "uint256" },
      { name: "reason", type: "string" },
    ],
  },
  {
    type: "error",
    name: "FailedOpWithRevert",
    inputs: [
      { name: "opIndex", type: "uint256" },
      { name: "reason", type: "string" },
      { name: "inner", type: "bytes" },
    ],
  },
] as const;

const errorAbi = [
  ...payeeGuardAccountAbi.filter((x) => x.type === "error"),
  ...invoicePayAbi.filter((x) => x.type === "error"),
  ...payeeRegistryAbi.filter((x) => x.type === "error"),
  ...entryPointErrors,
] as Abi;

export type ExplainedError = { name: string; args: readonly unknown[]; message: string; stage: "validation" | "execution" | "unknown" };

const usd = (x: unknown) => `${formatUnits(BigInt(x as bigint), TUSD8_DECIMALS)} tUSD8`;
const utc = (t: unknown) => new Date(Number(t) * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";

function describe(name: string, a: readonly unknown[]): string {
  switch (name) {
    case "SessionPerPaymentCapExceeded":
      return `Blocked by the smart account before execution: ${usd(a[0])} is above this session's per-payment cap of ${usd(a[1])}. The owner has to approve this payment.`;
    case "SessionDailyCapExceeded":
      return `Blocked by the smart account: this payment would bring today's session spending to ${usd(a[1])}, over the daily cap of ${usd(a[2])}.`;
    case "SessionPayeeNotAllowed":
      return `Blocked by the smart account: business #${a[0]} is not on this session's payee allowlist.`;
    case "SessionNotActive":
      return `Blocked by the smart account: session key ${a[0]} is revoked or was never granted.`;
    case "SessionTokenNotAllowed":
      return `Blocked by the smart account: this session may not pay in token ${a[0]}.`;
    case "SessionCallNotAllowed":
      return `Blocked by the smart account: a session key may only pay invoices (selector ${a[0]} refused).`;
    case "SessionKeyMismatch":
      return "Blocked by the smart account: the call names a different session key than the one that signed it.";
    case "PayeeInCoolingOff":
      return `Refused by InvoicePay: payout address ${a[1]} was added recently and is cooling off until ${utc(a[2])}.`;
    case "PayeeNotRegistered":
      return `Refused by InvoicePay: payout address ${a[1]} is not registered to business #${a[0]}.`;
    case "PayeeAwaitingApproval":
      return `Refused by InvoicePay: payout address ${a[1]} still needs the business's second approver.`;
    case "PayeeWasRevoked":
      return `Refused by InvoicePay: payout address ${a[1]} was revoked at ${utc(a[2])}.`;
    case "InvoiceAlreadyPaid":
      return `Refused by InvoicePay: this invoice was already paid at ${utc(a[1])}.`;
    case "InvoiceExpired":
      return `Refused by InvoicePay: the invoice expired at ${utc(a[0])}.`;
    case "InvalidInvoiceSignature":
      return "Refused by InvoicePay: the invoice is not signed by the business's registered key.";
    case "WrongPayer":
      return `Refused by InvoicePay: the invoice is addressed to ${a[0]}, not to this payer.`;
    case "ZeroAmount":
      return "Refused by InvoicePay: zero amount.";
    default:
      return `${name}(${a.map(String).join(", ")})`;
  }
}

function tryDecode(data: Hex): ExplainedError | undefined {
  try {
    const { errorName, args = [] } = decodeErrorResult({ abi: errorAbi, data });
    if (errorName === "FailedOpWithRevert") {
      const inner = tryDecode(args[2] as Hex);
      if (inner) return { ...inner, stage: "validation" };
      return { name: "FailedOpWithRevert", args, message: `Rejected at validation: ${args[1]}`, stage: "validation" };
    }
    if (errorName === "FailedOp") return explainAA(String(args[1]));
    return { name: errorName, args, message: describe(errorName, args), stage: "unknown" };
  } catch {
    return undefined;
  }
}

function explainAA(reason: string): ExplainedError {
  const code = reason.slice(0, 4);
  const messages: Record<string, string> = {
    AA21: "The smart account does not have enough tQDAY to prefund gas.",
    AA22: "Rejected at validation: outside the session's validity window (expired, or signed for another day).",
    AA23: "Rejected at validation: the smart account refused this operation.",
    AA24: "Rejected at validation: the signature is not valid for this account or session.",
    AA25: "Rejected: invalid account nonce (an operation was already sent with it).",
    AA31: "The paymaster's deposit is too low.",
    AA33: "Rejected by the paymaster.",
  };
  return { name: code, args: [reason], message: messages[code] ?? `Rejected by the EntryPoint: ${reason}`, stage: "validation" };
}

/**
 * Every string reachable from the error: viem's cause chain, and JSON-RPC error data such as rundler's
 * {reason, revertData} or Alto's revert bytes. revertData-like fields come first.
 */
function collect(err: unknown, out: string[] = [], depth = 0, seen = new Set<unknown>()): string[] {
  if (err === null || err === undefined || depth > 8 || seen.has(err)) return out;
  if (typeof err === "string") {
    out.push(err);
    return out;
  }
  if (typeof err !== "object") return out;
  seen.add(err);
  const e = err as Record<string, unknown>;
  const keys = [...new Set(["revertData", "data", "details", "shortMessage", "message", ...Object.keys(e), "cause"])];
  for (const k of keys) {
    if (k === "stack" || k === "abi" || k === "docsPath") continue;
    const v = e[k];
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") collect(v, out, depth + 1, seen);
  }
  return out;
}

/**
 * Turns a bundler, EntryPoint or contract error into one plain-language sentence, decoding PayeeGuard's custom errors
 * wherever their revert data appears (viem error chain, rundler/Alto JSON-RPC error data or message text).
 */
export function explainError(err: unknown): ExplainedError {
  const texts = collect(err);
  const atValidation = texts.some((t) => /AA2\d|validation reverted|validateUserOp/i.test(t));
  for (const t of texts) {
    for (const hex of t.match(/0x[0-9a-fA-F]{8,}/g) ?? []) {
      const decoded = tryDecode(hex as Hex);
      if (decoded) {
        const stage = decoded.stage !== "unknown" ? decoded.stage : atValidation ? "validation" : "execution";
        return { ...decoded, stage };
      }
    }
  }
  for (const t of texts) {
    const aa = /AA\d\d[^"\\]*/.exec(t);
    if (aa) return explainAA(aa[0]);
  }
  return { name: "Unknown", args: [], message: texts[0] ?? String(err), stage: "unknown" };
}
