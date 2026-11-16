import { getAddress, isHex, type Address, type Hex } from "viem";
import { aevumTestnet, payeeGuardAddresses } from "./chain.js";
import type { Invoice } from "./invoice.js";

/**
 * A signed invoice as it travels: a JSON file, or a text block inside an email/PDF. Only `invoice` and `signature`
 * are trusted (after checkInvoice); `display` is whatever the sender claims and is shown as unverified.
 */
export type SignedInvoice = {
  type: "payeeguard-invoice/v1";
  chainId: number;
  invoicePay: Address;
  invoice: Invoice;
  signature: Hex;
  display?: { businessName?: string; reference?: string; description?: string; amount?: string };
};

const BEGIN = "-----BEGIN PAYEEGUARD INVOICE-----";
const END = "-----END PAYEEGUARD INVOICE-----";

export function toSignedInvoice(invoice: Invoice, signature: Hex, display?: SignedInvoice["display"], chainId = aevumTestnet.id): SignedInvoice {
  return { type: "payeeguard-invoice/v1", chainId, invoicePay: payeeGuardAddresses(chainId).invoicePay, invoice, signature, display };
}

export function serializeSignedInvoice(s: SignedInvoice): string {
  return JSON.stringify(s, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

/** Text block to paste into an email or print on a PDF. */
export function signedInvoiceBlock(s: SignedInvoice): string {
  const b64 = btoa(serializeSignedInvoice(s)).replace(/(.{64})/g, "$1\n");
  return `${BEGIN}\n${b64}\n${END}`;
}

function parseObject(o: unknown): SignedInvoice {
  const x = o as Record<string, any>;
  if (x?.type !== "payeeguard-invoice/v1") throw new Error("Not a PayeeGuard invoice (missing type payeeguard-invoice/v1).");
  const i = x.invoice ?? {};
  const hex = (v: unknown, name: string) => {
    if (typeof v !== "string" || !isHex(v)) throw new Error(`Invoice field ${name} is not hex.`);
    return v as Hex;
  };
  return {
    type: "payeeguard-invoice/v1",
    chainId: Number(x.chainId),
    invoicePay: getAddress(x.invoicePay),
    signature: hex(x.signature, "signature"),
    display: x.display,
    invoice: {
      invoiceId: hex(i.invoiceId, "invoiceId"),
      payeeAgentId: BigInt(i.payeeAgentId),
      payTo: getAddress(i.payTo),
      token: getAddress(i.token),
      amount: BigInt(i.amount),
      payer: getAddress(i.payer),
      issuedAt: BigInt(i.issuedAt),
      dueBy: BigInt(i.dueBy),
      detailsHash: hex(i.detailsHash, "detailsHash"),
    },
  };
}

/**
 * Finds a signed invoice in arbitrary text: a BEGIN/END block (email, PDF text) or a raw JSON object.
 * Returns undefined when there is none; throws when one is present but malformed.
 */
export function findSignedInvoice(text: string): SignedInvoice | undefined {
  const start = text.indexOf(BEGIN);
  if (start >= 0) {
    const end = text.indexOf(END, start);
    if (end < 0) throw new Error("PayeeGuard invoice block is cut off (no END line).");
    const b64 = text.slice(start + BEGIN.length, end).replace(/[^A-Za-z0-9+/=]/g, "");
    return parseObject(JSON.parse(atob(b64)));
  }
  const brace = text.indexOf('{"type"') >= 0 ? text.indexOf('{"type"') : text.indexOf("{");
  if (brace >= 0 && text.includes("payeeguard-invoice/v1")) {
    const json = text.slice(brace, text.lastIndexOf("}") + 1);
    return parseObject(JSON.parse(json));
  }
  return undefined;
}
