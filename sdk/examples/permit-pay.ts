// EOA payer path of the web app, scripted: one EIP-2612 permit signature + payInvoiceWithPermit.
//   npx tsx examples/permit-pay.ts       (PAYER_OWNER pays a fresh 0.02 tUSD8 Forela invoice)
import { createPublicClient, createWalletClient, erc20Abi, http, parseSignature, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TUSD8, aevumTestnet, checkInvoice, explorerTx, invoicePayAbi, makeInvoice, payeeGuardAddresses, signInvoice } from "../src/index.js";

process.loadEnvFile(new URL("../../.env", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const client = createPublicClient({ chain: aevumTestnet, transport: http() });
const payer = privateKeyToAccount(process.env.PAYER_OWNER_KEY!.trim() as Hex);
const business = privateKeyToAccount(process.env.BUSINESS_KEY!.trim() as Hex);
const wallet = createWalletClient({ chain: aevumTestnet, transport: http(), account: payer });
const { invoicePay } = payeeGuardAddresses();

const now = Number((await client.getBlock()).timestamp);
const invoice = makeInvoice({ reference: `PERMIT-${now}`, payeeAgentId: 0n, payTo: business.address, token: TUSD8, amount: parseUnits("0.02", 6), payer: payer.address, dueInSeconds: 86400, now });
const signature = await signInvoice(business, invoice);
console.log("check:", (await checkInvoice(client, { invoice, signature, payer: payer.address })).verdict);

const deadline = BigInt(now + 1800);
const nonce = await client.readContract({ address: TUSD8, abi: [{ type: "function", name: "nonces", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "nonces", args: [payer.address] });
const permit = await payer.signTypedData({
  domain: { name: "tUSD8", version: "2", chainId: 44005, verifyingContract: TUSD8 },
  types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
  primaryType: "Permit",
  message: { owner: payer.address, spender: invoicePay, value: invoice.amount, nonce, deadline },
});
const { r, s, v } = parseSignature(permit);
const before = await client.readContract({ address: TUSD8, abi: erc20Abi, functionName: "allowance", args: [payer.address, invoicePay] });
const hash = await wallet.writeContract({ address: invoicePay, abi: invoicePayAbi, functionName: "payInvoiceWithPermit", args: [invoice, signature, deadline, Number(v), r, s] });
const receipt = await client.waitForTransactionReceipt({ hash });
const after = await client.readContract({ address: TUSD8, abi: erc20Abi, functionName: "allowance", args: [payer.address, invoicePay] });
console.log("paid with permit:", receipt.status, explorerTx(hash), "| allowance before/after:", before, after);
