// PayeeGuard invoice assistant.
//
//   tsx src/cli.ts grant                 owner grants the assistant a fresh session key (stored in .session.json)
//   tsx src/cli.ts pay <email.txt> [--dry-run]
//   tsx src/cli.ts pay <email.txt> --ignore-policy   demo: act like a compromised assistant; the account still refuses
//
// Reads an invoice email, finds the signed invoice, runs the on-chain payee check, extracts what the email text claims
// (heuristics by default, Claude with ASSISTANT_LLM=claude), decides, and pays through the session key when allowed.
// Every decision, including refusals the chain never sees, goes to logs/activity.jsonl.
// Keys come from the repo's git-ignored .env (PAYER_OWNER_KEY for `grant`) and .session.json; never printed.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, formatUnits, http, parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  TUSD8,
  aevumTestnet,
  checkInvoice,
  createPayeeGuardBundlerClient,
  currentDay,
  explainError,
  explorerTx,
  findSignedInvoice,
  getPayeeInfo,
  grantSessionCall,
  payInvoiceCall,
  payeeGuardAccountAbi,
  toPayeeGuardAccount,
} from "../../sdk/src/index.js";
import { extractClaims } from "./claims.js";
import { decide, type SessionLimits } from "./policy.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
process.loadEnvFile(join(root, "..", ".env"));
const SESSION_FILE = join(root, ".session.json");
const LOG = join(root, "logs", "activity.jsonl");
const SALT = BigInt(process.env.DEMO_SALT ?? 2);
const FORELA = 0n;

const client = createPublicClient({ chain: aevumTestnet, transport: http() });
const json = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));

function log(entry: Record<string, unknown>) {
  mkdirSync(dirname(LOG), { recursive: true });
  appendFileSync(LOG, json({ at: new Date().toISOString(), ...entry }) + "\n");
}

async function ownerAccount() {
  const owner = privateKeyToAccount(process.env.PAYER_OWNER_KEY!.trim() as Hex);
  return { owner, account: await toPayeeGuardAccount({ client, owner, salt: SALT }) };
}

async function grant() {
  const { account } = await ownerAccount();
  const key = generatePrivateKey();
  const session = privateKeyToAccount(key);
  const now = Number((await client.getBlock()).timestamp);
  const policy = {
    token: TUSD8,
    perPaymentCap: parseUnits(process.env.CAP ?? "0.10", 6),
    dailyCap: parseUnits(process.env.DAILY_CAP ?? "0.15", 6),
    validAfter: now - 60,
    validUntil: now + 7 * 86_400,
    restrictPayees: true,
  };
  const bundler = createPayeeGuardBundlerClient({ account, client, paymaster: true });
  const hash = await bundler.sendUserOperation({ calls: [grantSessionCall(account, session.address, policy, [FORELA])] });
  const receipt = await bundler.waitForUserOperationReceipt({ hash, timeout: 180_000 });
  writeFileSync(SESSION_FILE, JSON.stringify({ account: account.address, key, address: session.address }, null, 2));
  log({ event: "session_granted", account: account.address, session: session.address, policy, tx: receipt.receipt.transactionHash });
  console.log(`granted session ${session.address} on ${account.address}: ${formatUnits(policy.perPaymentCap, 6)} per payment, ${formatUnits(policy.dailyCap, 6)} per day, business #${FORELA} only`);
  console.log(explorerTx(receipt.receipt.transactionHash));
}

async function sessionLimits(account: Address, key: Address, payeeAgentId: bigint): Promise<SessionLimits> {
  const [s, allowed, spentToday] = await Promise.all([
    client.readContract({ address: account, abi: payeeGuardAccountAbi, functionName: "sessionOf", args: [key] }),
    client.readContract({ address: account, abi: payeeGuardAccountAbi, functionName: "isPayeeAllowed", args: [key, payeeAgentId] }),
    currentDay(client).then((day) =>
      client.readContract({ address: account, abi: payeeGuardAccountAbi, functionName: "spentOn", args: [key, day] }),
    ),
  ]);
  return {
    active: s.grantId !== 0n,
    token: s.policy.token,
    perPaymentCap: s.policy.perPaymentCap,
    dailyCap: s.policy.dailyCap,
    spentToday,
    validUntil: Number(s.policy.validUntil),
    payeeAllowed: allowed,
  };
}

async function pay(file: string, flag?: string) {
  const dryRun = flag === "--dry-run";
  if (!existsSync(SESSION_FILE)) throw new Error("No session yet: run `pnpm grant` first (the owner grants the assistant a key).");
  const saved = JSON.parse(readFileSync(SESSION_FILE, "utf8")) as { account: Address; key: Hex; address: Address };
  const email = readFileSync(file, "utf8");
  const now = Number((await client.getBlock()).timestamp);

  let signed;
  let parseError: string | undefined;
  try {
    signed = findSignedInvoice(email);
  } catch (e) {
    parseError = (e as Error).message;
  }
  const claims = await extractClaims(email);
  const check = signed ? await checkInvoice(client, { invoice: signed.invoice, signature: signed.signature, payer: saved.account }) : undefined;
  const payee = signed ? await getPayeeInfo(client, signed.invoice.payeeAgentId, signed.invoice.payTo) : undefined;
  const session = signed ? await sessionLimits(saved.account, saved.address, signed.invoice.payeeAgentId) : undefined;
  const decision = decide({ signed, check, payee, claims, session, now });
  if (parseError) decision.reasons.unshift(`Invoice block unreadable: ${parseError}`);

  console.log(`\nemail: ${claims.summary}`);
  console.log(`claims (${claims.extractor}): business=${claims.claimedBusinessName ?? "-"} amount=${claims.claimedAmount ?? "-"} bankChange=${claims.mentionsBankDetailChange} urgency=${claims.urgencyPressure}`);
  if (signed) console.log(`signed invoice: ${formatUnits(signed.invoice.amount, 6)} tUSD8 to business #${signed.invoice.payeeAgentId} at ${signed.invoice.payTo}`);
  if (check) console.log(`on-chain check: ${check.verdict}`);
  for (const w of decision.warnings) console.log(`warning: ${w}`);
  console.log(`decision: ${decision.action.toUpperCase()}`);
  for (const r of decision.reasons) console.log(`  - ${r}`);

  const entry = { event: "invoice", file, decision, claims, verdict: check?.verdict, invoice: signed?.invoice, account: saved.account, session: saved.address };
  // Demo of defence in depth: a compromised assistant that ignores its own policy still cannot pass the account.
  const forced = flag === "--ignore-policy" && decision.action === "ask_owner" && !!signed;
  if (forced) console.log("  !! --ignore-policy: sending anyway, as a compromised assistant would");
  if ((decision.action !== "pay" && !forced) || dryRun) {
    log({ ...entry, executed: false, dryRun });
    if (decision.action === "ask_owner") console.log("  -> waiting for the owner: approve in the web app (Agent account) or pay as owner.");
    return;
  }

  const agent = privateKeyToAccount(saved.key);
  const account = await toPayeeGuardAccount({ client, owner: (await ownerAccount()).owner.address, session: agent, salt: SALT });
  const bundler = createPayeeGuardBundlerClient({ account, client, paymaster: true });
  try {
    const hash = await bundler.sendUserOperation({ calls: [payInvoiceCall(account, signed!.invoice, signed!.signature, agent.address)] });
    const receipt = await bundler.waitForUserOperationReceipt({ hash, timeout: 180_000 });
    log({ ...entry, executed: receipt.success, userOpHash: hash, tx: receipt.receipt.transactionHash });
    console.log(`  -> paid through the session key (gas in tUSD8): ${explorerTx(receipt.receipt.transactionHash)}`);
  } catch (e) {
    // The account itself refused (validateUserOp): the chain never sees it, so the log is the only trace.
    const why = explainError(e);
    log({ ...entry, executed: false, rejectedBy: why.stage, reason: why.message });
    console.log(`  -> rejected at ${why.stage}: ${why.message}`);
  }
}

const [cmd, arg, flag] = process.argv.slice(2);
(cmd === "grant" ? grant() : cmd === "pay" && arg ? pay(arg, flag) : Promise.reject(new Error("usage: grant | pay <email.txt> [--dry-run | --ignore-policy]")))
  .catch((e) => {
    console.error(explainError(e).message);
    process.exit(1);
  });
