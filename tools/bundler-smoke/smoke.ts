// Sends one ERC-4337 v0.7 UserOperation through a bundler on Aevum testnet (chain 44005).
// It deploys a fresh sample SimpleAccount through initCode (the heaviest path: factory + validation + execution),
// funds it with a little tQDAY from DEPLOYER, and waits for the receipt.
//
//   BUNDLER_URL=https://bundler.qday.info pnpm smoke      (QDay's rundler, default)
//   BUNDLER_URL=http://127.0.0.1:4337 pnpm smoke          (our own Alto)
//
// Keys come from the repo's git-ignored .env and are never printed.
import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createBundlerClient, entryPoint07Address } from "viem/account-abstraction";
import { toSimpleSmartAccount } from "permissionless/accounts";

process.loadEnvFile(new URL("../../.env", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const aevum = defineChain({
  id: 44005,
  name: "QDay Aevum Testnet",
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc-test.qday.info"] } },
  blockExplorers: { default: { name: "Aevum explorer", url: "https://explorer-test.qday.info" } },
});

const BUNDLER_URL = process.env.BUNDLER_URL ?? "https://bundler.qday.info";
const FACTORY = (process.env.SMOKE_FACTORY ?? "0x05421d7B82bb1Eab471C31Ba516a7359506fc243") as Hex;
const INDEX = BigInt(process.env.SMOKE_INDEX ?? Date.now());

const env = (name: string) => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} missing in .env`);
  return v as Hex;
};

const publicClient = createPublicClient({ chain: aevum, transport: http() });
const deployer = createWalletClient({ chain: aevum, transport: http(), account: privateKeyToAccount(env("DEPLOYER_KEY")) });
const owner = privateKeyToAccount(env("PAYER_OWNER_KEY"));

async function fees() {
  const block = await publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  let priority: bigint;
  try {
    // rundler exposes its minimum acceptable priority fee
    priority = BigInt(await publicClient.transport.request({ method: "rundler_maxPriorityFeePerGas" } as never) as string);
  } catch {
    priority = await publicClient.estimateMaxPriorityFeePerGas();
  }
  try {
    const bundler = createPublicClient({ chain: aevum, transport: http(BUNDLER_URL) });
    priority = BigInt(await bundler.request({ method: "rundler_maxPriorityFeePerGas" } as never) as string);
  } catch {}
  priority = (priority * 12n) / 10n; // 20 % headroom over the bundler's floor
  return { maxPriorityFeePerGas: priority, maxFeePerGas: baseFee * 2n + priority };
}

async function main() {
  const bundlerProbe = createPublicClient({ chain: aevum, transport: http(BUNDLER_URL) });
  const entryPoints = await bundlerProbe.request({ method: "eth_supportedEntryPoints" } as never);
  console.log("bundler", BUNDLER_URL, "entry points", entryPoints);

  const account = await toSimpleSmartAccount({
    client: publicClient,
    owner,
    factoryAddress: FACTORY,
    index: INDEX,
    entryPoint: { address: entryPoint07Address, version: "0.7" },
  });
  console.log("smart account", account.address, "index", INDEX.toString());

  const balance = await publicClient.getBalance({ address: account.address });
  if (balance < parseEther("0.005")) {
    const tx = await deployer.sendTransaction({ to: account.address, value: parseEther("0.01") });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log("prefund 0.01 tQDAY tx", tx);
  }

  const bundler = createBundlerClient({
    account,
    client: publicClient,
    transport: http(BUNDLER_URL),
    userOperation: { estimateFeesPerGas: fees },
  });

  const started = Date.now();
  const userOp = await bundler.prepareUserOperation({
    calls: [{ to: deployer.account.address, value: 0n, data: "0x" }],
  });
  console.log("estimated gas", {
    verificationGasLimit: userOp.verificationGasLimit,
    callGasLimit: userOp.callGasLimit,
    preVerificationGas: userOp.preVerificationGas,
    maxFeePerGas: userOp.maxFeePerGas,
    maxPriorityFeePerGas: userOp.maxPriorityFeePerGas,
  });
  const signature = await account.signUserOperation(userOp);
  const hash = await bundler.sendUserOperation({ ...userOp, signature });
  console.log("userOpHash", hash);
  const receipt = await bundler.waitForUserOperationReceipt({ hash, timeout: 180_000, pollingInterval: 2_000 });
  console.log("success", receipt.success, "tx", receipt.receipt.transactionHash, "block", receipt.receipt.blockNumber);
  console.log("actualGasUsed", receipt.actualGasUsed, "actualGasCost", formatEther(receipt.actualGasCost), "tQDAY");
  console.log("seconds to receipt", ((Date.now() - started) / 1000).toFixed(1));
  console.log(`${aevum.blockExplorers.default.url}/tx/${receipt.receipt.transactionHash}`);
  if (!receipt.success) process.exit(1);
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  if (e?.details) console.error("details:", e.details);
  process.exit(1);
});
