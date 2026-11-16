import {
  keccak256,
  stringToHex,
  toBytes,
  zeroAddress,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
} from "viem";
import { invoicePayAbi } from "./abis.js";
import { aevumTestnet, payeeGuardAddresses } from "./chain.js";

/** Mirrors `struct Invoice` in InvoicePay.sol. */
export type Invoice = {
  invoiceId: Hex;
  payeeAgentId: bigint;
  payTo: Address;
  token: Address;
  amount: bigint;
  payer: Address;
  issuedAt: bigint;
  dueBy: bigint;
  detailsHash: Hex;
};

export const invoiceTypes = {
  Invoice: [
    { name: "invoiceId", type: "bytes32" },
    { name: "payeeAgentId", type: "uint256" },
    { name: "payTo", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "payer", type: "address" },
    { name: "issuedAt", type: "uint64" },
    { name: "dueBy", type: "uint64" },
    { name: "detailsHash", type: "bytes32" },
  ],
} as const;

export function invoiceDomain(chainId: number = aevumTestnet.id, invoicePay?: Address) {
  return {
    name: "PayeeGuard InvoicePay",
    version: "1",
    chainId,
    verifyingContract: invoicePay ?? payeeGuardAddresses(chainId).invoicePay,
  } as const;
}

/** A readable reference ("INV-2026-0042") becomes the bytes32 invoiceId; longer ones are hashed. */
export function invoiceIdFromReference(reference: string): Hex {
  return toBytes(reference).length <= 32 ? stringToHex(reference, { size: 32 }) : keccak256(toBytes(reference));
}

/** Hash of the human-readable invoice (line items, PDF text) that the signature commits to. */
export function detailsHash(details: string | Uint8Array): Hex {
  return keccak256(typeof details === "string" ? toBytes(details) : details);
}

export function makeInvoice(fields: {
  reference: string;
  payeeAgentId: bigint;
  payTo: Address;
  token: Address;
  amount: bigint;
  payer?: Address;
  dueInSeconds?: number;
  details?: string;
  now?: number;
}): Invoice {
  const now = BigInt(fields.now ?? Math.floor(Date.now() / 1000));
  return {
    invoiceId: invoiceIdFromReference(fields.reference),
    payeeAgentId: fields.payeeAgentId,
    payTo: fields.payTo,
    token: fields.token,
    amount: fields.amount,
    payer: fields.payer ?? zeroAddress,
    issuedAt: now,
    dueBy: fields.dueInSeconds ? now + BigInt(fields.dueInSeconds) : 0n,
    detailsHash: detailsHash(fields.details ?? fields.reference),
  };
}

/** The business (identity owner or its invoice signer) signs the invoice as EIP-712 typed data. */
export async function signInvoice(
  signer: Pick<LocalAccount, "signTypedData">,
  invoice: Invoice,
  opts: { chainId?: number; invoicePay?: Address } = {},
): Promise<Hex> {
  return signer.signTypedData({
    domain: invoiceDomain(opts.chainId, opts.invoicePay),
    types: invoiceTypes,
    primaryType: "Invoice",
    message: invoice,
  });
}

export const VERDICTS = [
  "Payable",
  "ZeroAmount",
  "Expired",
  "WrongPayer",
  "AlreadyPaid",
  "BadSignature",
  "PayeeNotRegistered",
  "PayeeAwaitingApproval",
  "PayeeInCoolingOff",
  "PayeeRevoked",
] as const;
export type Verdict = (typeof VERDICTS)[number];

export type InvoiceCheck = {
  verdict: Verdict;
  ok: boolean;
  /** dueBy, paidAt, or the payout address's activeAt / revokedAt, depending on the verdict (unix seconds). */
  at: bigint;
  message: string;
};

/** Runs InvoicePay.checkInvoice (a non-reverting view) and explains the verdict in plain language. */
export async function checkInvoice(
  client: PublicClient,
  params: { invoice: Invoice; signature: Hex; payer: Address; invoicePay?: Address },
): Promise<InvoiceCheck> {
  const invoicePay = params.invoicePay ?? payeeGuardAddresses(client.chain?.id).invoicePay;
  const [code, at] = await client.readContract({
    address: invoicePay,
    abi: invoicePayAbi,
    functionName: "checkInvoice",
    args: [params.invoice, params.signature, params.payer],
  });
  const verdict = VERDICTS[code] ?? "BadSignature";
  const block = await client.getBlock();
  return { verdict, ok: verdict === "Payable", at, message: explainVerdict(verdict, at, block.timestamp) };
}

const utc = (t: bigint) => new Date(Number(t) * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";

function ago(now: bigint, t: bigint) {
  const s = Number(now - t);
  if (s < 120) return `${s} seconds ago`;
  if (s < 7200) return `${Math.round(s / 60)} minutes ago`;
  if (s < 172800) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function explainVerdict(verdict: Verdict, at: bigint, now: bigint): string {
  switch (verdict) {
    case "Payable":
      return `Payable. The payout address is registered to this business and has been active since ${utc(at)} (${ago(now, at)}).`;
    case "ZeroAmount":
      return "Refused: the invoice amount is zero.";
    case "Expired":
      return `Refused: the invoice expired at ${utc(at)}. Ask the business for a new one.`;
    case "WrongPayer":
      return "Refused: this invoice is addressed to a different payer.";
    case "AlreadyPaid":
      return `Refused: this invoice was already paid at ${utc(at)}. Paying twice is blocked on chain.`;
    case "BadSignature":
      return "Refused: the invoice is not signed by this business's registered key. It may be forged or altered.";
    case "PayeeNotRegistered":
      return "Refused: the payout address on this invoice is not registered to this business. Treat it as fraud; confirm by phone on a number you already know.";
    case "PayeeAwaitingApproval":
      return "Refused: this payout address was added recently and still needs the business's second approver. Do not pay it yet.";
    case "PayeeInCoolingOff":
      return `Refused: this payout address was added to the business's identity recently and is in its cooling-off until ${utc(at)}. "Our bank details have changed" is the classic invoice-fraud move: confirm with the business on a known number before paying.`;
    case "PayeeRevoked":
      return `Refused: the business revoked this payout address at ${utc(at)}.`;
  }
}
