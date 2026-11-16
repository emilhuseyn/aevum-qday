// Lead 2 on Aevum testnet through QDay's own bundler (rundler, ERC-7562 safe mode):
//   0. with the tUSD8 paymaster (default) the payer account never holds tQDAY: gas comes out of prepaid tUSD8 credit
//   1. the owner grants an AI agent a session key (deploying the account through initCode if needed)
//   2. the agent pays Forela's signed invoice within its caps            -> paid, receipt on chain
//   3. the agent tries a 5.00 tUSD8 invoice                               -> rejected at validation (over cap)
//   4. the owner revokes the session in one call
//   5. the agent tries again                                              -> rejected at validation (revoked)
//
//   pnpm tsx examples/session-demo.ts            BUNDLER_URL=http://127.0.0.1:4337 for our own Alto
// Keys come from the repo's git-ignored .env and are never printed.
import { createPublicClient, createWalletClient, erc20Abi, formatEther, formatUnits, http, parseEther, parseUnits, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  TUSD8,
  aevumTestnet,
  checkInvoice,
  createPayeeGuardBundlerClient,
  explainError,
  explorerTx,
  grantSessionCall,
  makeInvoice,
  payeeGuardAddresses,
  payeeGuardPaymasterAbi,
  payInvoiceCall,
  revokeSessionCall,
  signInvoice,
  toPayeeGuardAccount,
} from "../src/index.js";

process.loadEnvFile(new URL("../../.env", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const key = (name: string) => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} missing in .env`);
  return v as Hex;
};

const FORELA_AGENT_ID = 0n; // registered by contracts/script/DemoFlow.s.sol
const USE_PAYMASTER = !process.env.NO_PAYMASTER;
const SALT = BigInt(process.env.DEMO_SALT ?? (USE_PAYMASTER ? 2 : 1));
const BUNDLER_URL = process.env.BUNDLER_URL;

const client = createPublicClient({ chain: aevumTestnet, transport: http() });
const deployer = createWalletClient({ chain: aevumTestnet, transport: http(), account: privateKeyToAccount(key("DEPLOYER_KEY")) });
const owner = privateKeyToAccount(key("PAYER_OWNER_KEY"));
// Each run hands the assistant a fresh session key (kept in memory only), as a real deployment would. Daily spend is
// tracked per session key, so re-granting the same key on the same day would not reset its budget.
const agent = privateKeyToAccount(process.env.DEMO_AGENT_FROM_ENV ? key("AGENT_SESSION_KEY") : generatePrivateKey());
const business = privateKeyToAccount(key("BUSINESS_KEY"));

const usd = (x: bigint) => `${formatUnits(x, 6)} tUSD8`;
const step = (s: string) => console.log(`\n== ${s}`);

async function invoiceFor(reference: string, amount: string) {
  const invoice = makeInvoice({
    reference,
    payeeAgentId: FORELA_AGENT_ID,
    payTo: business.address,
    token: TUSD8,
    amount: parseUnits(amount, 6),
    dueInSeconds: 7 * 86400,
    details: `Forela Ltd ${reference}: security review`,
    now: Number((await client.getBlock()).timestamp),
  });
  return { invoice, signature: await signInvoice(business, invoice) };
}

async function main() {
  const ownerAccount = await toPayeeGuardAccount({ client, owner, salt: SALT });
  const agentAccount = await toPayeeGuardAccount({ client, owner: owner.address, session: agent, salt: SALT });
  const paymaster = payeeGuardAddresses().paymaster;
  const ownerBundler = createPayeeGuardBundlerClient({ account: ownerAccount, client, bundlerUrl: BUNDLER_URL, paymaster: USE_PAYMASTER });
  const agentBundler = createPayeeGuardBundlerClient({ account: agentAccount, client, bundlerUrl: BUNDLER_URL, paymaster: USE_PAYMASTER });
  console.log("smart account", ownerAccount.address, "owner", owner.address, "agent session", agent.address);

  if (USE_PAYMASTER) {
    step("fund: an on-ramp prepays 0.02 tUSD8 of gas credit in the paymaster and sends 0.06 tUSD8 to spend (no tQDAY)");
    const credit = await client.readContract({ address: paymaster, abi: payeeGuardPaymasterAbi, functionName: "credit", args: [ownerAccount.address] });
    if (credit < parseUnits("0.005", 6)) {
      const amount = parseUnits("0.02", 6);
      const a = await deployer.writeContract({ address: TUSD8, abi: erc20Abi, functionName: "approve", args: [paymaster, amount] });
      await client.waitForTransactionReceipt({ hash: a });
      const d = await deployer.writeContract({ address: paymaster, abi: payeeGuardPaymasterAbi, functionName: "depositFor", args: [ownerAccount.address, amount] });
      await client.waitForTransactionReceipt({ hash: d });
      console.log("gas credit", explorerTx(d));
    }
  } else {
    step("fund: 0.03 tQDAY for gas (no paymaster) and 0.06 tUSD8 to spend");
    if ((await client.getBalance({ address: ownerAccount.address })) < parseEther("0.01")) {
      const tx = await deployer.sendTransaction({ to: ownerAccount.address, value: parseEther("0.03") });
      await client.waitForTransactionReceipt({ hash: tx });
      console.log("tQDAY", explorerTx(tx));
    }
  }
  const balance = await client.readContract({ address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [ownerAccount.address] });
  if (balance < parseUnits("0.05", 6)) {
    const tx = await deployer.writeContract({ address: TUSD8, abi: erc20Abi, functionName: "transfer", args: [ownerAccount.address, parseUnits("0.06", 6)] });
    await client.waitForTransactionReceipt({ hash: tx });
    console.log("tUSD8", explorerTx(tx));
  }
  const creditBefore = USE_PAYMASTER
    ? await client.readContract({ address: paymaster, abi: payeeGuardPaymasterAbi, functionName: "credit", args: [ownerAccount.address] })
    : 0n;

  step("1. owner grants the agent a session: only Forela, 0.10 per payment, 0.15 per day, 7 days");
  const now = Number((await client.getBlock()).timestamp);
  const grant = grantSessionCall(
    ownerAccount,
    agent.address,
    {
      token: TUSD8,
      perPaymentCap: parseUnits("0.10", 6),
      dailyCap: parseUnits("0.15", 6),
      validAfter: now - 60,
      validUntil: now + 7 * 86400,
      restrictPayees: true,
    },
    [FORELA_AGENT_ID],
  );
  const grantHash = await ownerBundler.sendUserOperation({ calls: [grant] });
  const grantReceipt = await ownerBundler.waitForUserOperationReceipt({ hash: grantHash, timeout: 180_000 });
  console.log("granted:", grantReceipt.success, explorerTx(grantReceipt.receipt.transactionHash));

  step("2. agent pays Forela's real invoice (0.05 tUSD8)");
  const real = await invoiceFor(`FORELA-${now}`, "0.05");
  const verdict = await checkInvoice(client, { invoice: real.invoice, signature: real.signature, payer: ownerAccount.address });
  console.log("payee check:", verdict.verdict, "-", verdict.message);
  const payHash = await agentBundler.sendUserOperation({ calls: [payInvoiceCall(ownerAccount, real.invoice, real.signature, agent.address)] });
  const payReceipt = await agentBundler.waitForUserOperationReceipt({ hash: payHash, timeout: 180_000 });
  console.log("paid:", payReceipt.success, explorerTx(payReceipt.receipt.transactionHash), "gas cost", formatEther(payReceipt.actualGasCost), "tQDAY");

  step("3. agent is asked to pay 5.00 tUSD8 (over its 0.10 cap)");
  const big = await invoiceFor(`FORELA-${now}-BIG`, "5.00");
  try {
    await agentBundler.sendUserOperation({ calls: [payInvoiceCall(ownerAccount, big.invoice, big.signature, agent.address)] });
    console.log("UNEXPECTED: over-cap payment was accepted");
    process.exitCode = 1;
  } catch (e) {
    const x = explainError(e);
    console.log(`rejected (${x.stage}, ${x.name}):`, x.message);
  }

  step("4. owner revokes the session");
  const revokeHash = await ownerBundler.sendUserOperation({ calls: [revokeSessionCall(ownerAccount, agent.address)] });
  const revokeReceipt = await ownerBundler.waitForUserOperationReceipt({ hash: revokeHash, timeout: 180_000 });
  console.log("revoked:", revokeReceipt.success, explorerTx(revokeReceipt.receipt.transactionHash));

  step("5. agent tries a small payment again");
  const again = await invoiceFor(`FORELA-${now}-AGAIN`, "0.02");
  try {
    await agentBundler.sendUserOperation({ calls: [payInvoiceCall(ownerAccount, again.invoice, again.signature, agent.address)] });
    console.log("UNEXPECTED: revoked session still works");
    process.exitCode = 1;
  } catch (e) {
    const x = explainError(e);
    console.log(`rejected (${x.stage}, ${x.name}):`, x.message);
  }

  const left = await client.readContract({ address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [ownerAccount.address] });
  const native = await client.getBalance({ address: ownerAccount.address });
  console.log("\naccount tUSD8 left:", usd(left), "| account tQDAY:", formatEther(native));
  if (USE_PAYMASTER) {
    const creditAfter = await client.readContract({ address: paymaster, abi: payeeGuardPaymasterAbi, functionName: "credit", args: [ownerAccount.address] });
    console.log("gas paid in tUSD8 by this run:", usd(creditBefore - creditAfter), "| credit left:", usd(creditAfter));
  }
}

main().catch((e) => {
  const x = explainError(e);
  console.error("FAILED:", x.name, x.message);
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
