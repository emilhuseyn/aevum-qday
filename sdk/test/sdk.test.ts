import { describe, expect, it } from "vitest";
import {
  createPublicClient,
  encodeErrorResult,
  hashTypedData,
  http,
  parseUnits,
  size,
  zeroAddress,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DUMMY_ECDSA,
  TUSD8,
  aevumTestnet,
  encodeSessionSignature,
  explainError,
  explainVerdict,
  invoiceDomain,
  invoiceIdFromReference,
  invoicePayAbi,
  invoiceTypes,
  makeInvoice,
  payeeGuardAccountAbi,
  payeeGuardAddresses,
  payeeRegistryAbi,
  sessionMessage,
  signInvoice,
} from "../src/index.js";

const business = privateKeyToAccount(generatePrivateKey());

describe("signatures", () => {
  it("dummy ECDSA signature is exactly 65 bytes (an odd-length stub made rundler reject the whole op)", () => {
    expect(size(DUMMY_ECDSA)).toBe(65);
  });

  it("session signature is 0x01 | key | day | ecdsa = 90 bytes", () => {
    const sig = encodeSessionSignature(business.address, 20_773, DUMMY_ECDSA);
    expect(size(sig)).toBe(90);
    expect(sig.slice(0, 4)).toBe("0x01");
    expect(sig.slice(4, 44).toLowerCase()).toBe(business.address.slice(2).toLowerCase());
    expect(sig.slice(44, 52)).toBe((20_773).toString(16).padStart(8, "0"));
  });

  it("session message binds the day", () => {
    const h = `0x${"11".repeat(32)}` as Hex;
    expect(sessionMessage(h, 1)).not.toBe(sessionMessage(h, 2));
  });
});

describe("invoices", () => {
  it("readable references map to bytes32 ids", () => {
    expect(invoiceIdFromReference("INV-0042").length).toBe(66);
    expect(invoiceIdFromReference("x".repeat(40))).not.toBe(invoiceIdFromReference("x".repeat(41)));
  });

  it("signs EIP-712 typed data that recovers to the business", async () => {
    const invoice = makeInvoice({
      reference: "INV-0042",
      payeeAgentId: 0n,
      payTo: business.address,
      token: TUSD8,
      amount: parseUnits("0.25", 6),
      now: 1_794_816_000,
    });
    expect(invoice.payer).toBe(zeroAddress);
    expect(invoice.dueBy).toBe(0n);
    const signature = await signInvoice(business, invoice);
    const { recoverTypedDataAddress } = await import("viem");
    const recovered = await recoverTypedDataAddress({
      domain: invoiceDomain(),
      types: invoiceTypes,
      primaryType: "Invoice",
      message: invoice,
      signature,
    });
    expect(recovered).toBe(business.address);
  });

  it("explains a cooling-off verdict in plain language", () => {
    const msg = explainVerdict("PayeeInCoolingOff", 1_794_816_120n, 1_794_816_000n);
    expect(msg).toMatch(/cooling-off until 2026-11-16 08:02 UTC/);
    expect(msg).toMatch(/bank details have changed/);
  });
});

describe("error explanations", () => {
  const rundlerError = (revertData: Hex) => ({
    shortMessage: "The `validateUserOp` function on the Smart Account reverted.",
    details: "validation reverted: [reason]: AA23 reverted",
    cause: { code: -32500, data: { reason: "AA23 reverted", innerReason: null, revertData } },
  });

  it("decodes a session cap breach from rundler's revertData", () => {
    const data = encodeErrorResult({
      abi: payeeGuardAccountAbi,
      errorName: "SessionPerPaymentCapExceeded",
      args: [5_000_000n, 100_000n],
    });
    const x = explainError(rundlerError(data));
    expect(x.name).toBe("SessionPerPaymentCapExceeded");
    expect(x.stage).toBe("validation");
    expect(x.message).toMatch(/5 tUSD8 is above this session's per-payment cap of 0.1 tUSD8/);
  });

  it("decodes registry refusals bubbled through InvoicePay", () => {
    const data = encodeErrorResult({
      abi: payeeRegistryAbi,
      errorName: "PayeeInCoolingOff",
      args: [0n, business.address, 1_794_816_120n],
    });
    const x = explainError({ shortMessage: "execution reverted", cause: { data } });
    expect(x.name).toBe("PayeeInCoolingOff");
    expect(x.stage).toBe("execution");
  });

  it("decodes InvoicePay errors", () => {
    const data = encodeErrorResult({ abi: invoicePayAbi, errorName: "InvalidInvoiceSignature" });
    expect(explainError({ details: `reverted with ${data}` }).name).toBe("InvalidInvoiceSignature");
  });

  it("maps bare EntryPoint codes", () => {
    expect(explainError({ details: "validation reverted: [reason]: AA22 expired or not due" }).name).toBe("AA22");
    expect(explainError({ details: "AA24 signature error" }).message).toMatch(/signature/);
  });
});

// Reads the live testnet. Run with AEVUM_INTEGRATION=1.
describe.runIf(process.env.AEVUM_INTEGRATION === "1")("Aevum testnet", () => {
  const client = createPublicClient({ chain: aevumTestnet, transport: http() });
  const addresses = payeeGuardAddresses();

  it("SDK typed-data hash equals InvoicePay.hashInvoice on chain", async () => {
    const invoice = makeInvoice({ reference: "PARITY", payeeAgentId: 0n, payTo: business.address, token: TUSD8, amount: 1n, now: 1 });
    const onchain = await client.readContract({ address: addresses.invoicePay, abi: invoicePayAbi, functionName: "hashInvoice", args: [invoice] });
    expect(onchain).toBe(hashTypedData({ domain: invoiceDomain(), types: invoiceTypes, primaryType: "Invoice", message: invoice }));
  });

  it("SDK session message equals PayeeGuardAccount.sessionDigest on chain", async () => {
    const { hashMessage } = await import("viem");
    const h = `0x${"ab".repeat(32)}` as Hex;
    const impl = (await import("../src/deployments.js")).deployments["44005"].accountImplementation as Hex;
    const onchain = await client.readContract({ address: impl, abi: payeeGuardAccountAbi, functionName: "sessionDigest", args: [h, 20_773] });
    expect(onchain).toBe(hashMessage({ raw: sessionMessage(h, 20_773) }));
  });
});

describe("signed invoice files", async () => {
  const { toSignedInvoice, signedInvoiceBlock, serializeSignedInvoice, findSignedInvoice } = await import("../src/index.js");
  const invoice = makeInvoice({ reference: "INV-7", payeeAgentId: 3n, payTo: business.address, token: TUSD8, amount: 250_000n, now: 1 });
  const signed = toSignedInvoice(invoice, DUMMY_ECDSA, { businessName: "Forela Ltd" });

  it("round-trips through an email text block", () => {
    const email = `Hi,\nplease find our invoice below.\n\n${signedInvoiceBlock(signed)}\n\nThanks, Forela`;
    expect(findSignedInvoice(email)).toEqual(signed);
  });

  it("round-trips through a JSON file", () => {
    expect(findSignedInvoice(serializeSignedInvoice(signed))).toEqual(signed);
  });

  it("returns undefined when there is no invoice and rejects a cut-off block", () => {
    expect(findSignedInvoice("please pay 0x1234 asap")).toBeUndefined();
    expect(() => findSignedInvoice("-----BEGIN PAYEEGUARD INVOICE-----\nabc")).toThrow(/cut off/);
  });
});
