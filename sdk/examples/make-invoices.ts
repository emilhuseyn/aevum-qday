// Writes two signed Forela invoices for trying the web app's "Check & pay" view:
//   legit.txt  - pays Forela's active payout address (verdict Payable)
//   fake.txt   - same business key, "new bank details" address that is not active (verdict refused)
//   npx tsx examples/make-invoices.ts <outDir>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TUSD8, aevumTestnet, makeInvoice, signInvoice, signedInvoiceBlock, toSignedInvoice } from "../src/index.js";

process.loadEnvFile(new URL("../../.env", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const business = privateKeyToAccount(process.env.BUSINESS_KEY!.trim() as Hex);
const attacker = process.env.ATTACKER_ADDR!.trim() as Hex;
const out = process.argv[2] ?? ".";
const client = createPublicClient({ chain: aevumTestnet, transport: http() });
const now = Number((await client.getBlock()).timestamp);

for (const [file, payTo, ref, note] of [
  ["legit.txt", business.address, `INV-${now % 100000}`, "Thanks for your business."],
  ["fake.txt", attacker, `INV-${(now % 100000) + 1}`, "Please note our bank details have changed. Use the new address below."],
] as const) {
  const invoice = makeInvoice({ reference: ref, payeeAgentId: 0n, payTo, token: TUSD8, amount: parseUnits("0.05", 6), dueInSeconds: 14 * 86400, details: `Forela Ltd ${ref}`, now });
  const signed = toSignedInvoice(invoice, await signInvoice(business, invoice), { businessName: "Forela Ltd (demo business)", reference: ref, description: "Security review, November", amount: "0.05 tUSD8" });
  const email = `From: billing@forela.example\nSubject: Invoice ${ref}\n\nHello,\n\n${note}\nAmount due: 0.05 tUSD8.\n\n${signedInvoiceBlock(signed)}\n\nForela Ltd\n`;
  writeFileSync(join(out, file), email);
  console.log("wrote", join(out, file));
}
