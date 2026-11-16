import { http, type Chain, type Client, type JsonRpcAccount, type LocalAccount, type Transport } from "viem";
import { createBundlerClient, type SmartAccount } from "viem/account-abstraction";
import { estimateMaxPriorityFeePerGas, getBlock } from "viem/actions";
import { QDAY_BUNDLER_URL } from "./chain.js";

type AnyClient = Client<Transport, Chain | undefined, JsonRpcAccount | LocalAccount | undefined>;

/**
 * Fees that both bundlers accept on Aevum: rundler (QDay) publishes its minimum priority fee via
 * rundler_maxPriorityFeePerGas, Alto via pimlico_getUserOperationGasPrice; otherwise ask the node. 20 % headroom.
 */
export async function estimateUserOpFees(client: AnyClient, bundler: { request: (a: never) => Promise<unknown> }) {
  const block = await getBlock(client);
  const baseFee = block.baseFeePerGas ?? 0n;
  let priority: bigint | undefined;
  try {
    priority = BigInt((await bundler.request({ method: "rundler_maxPriorityFeePerGas" } as never)) as string);
  } catch {
    try {
      const r = (await bundler.request({ method: "pimlico_getUserOperationGasPrice" } as never)) as {
        fast: { maxFeePerGas: string; maxPriorityFeePerGas: string };
      };
      return { maxFeePerGas: BigInt(r.fast.maxFeePerGas), maxPriorityFeePerGas: BigInt(r.fast.maxPriorityFeePerGas) };
    } catch {
      priority = await estimateMaxPriorityFeePerGas(client);
    }
  }
  priority = (priority * 12n) / 10n;
  return { maxPriorityFeePerGas: priority, maxFeePerGas: baseFee * 2n + priority };
}

/**
 * Bundler client for a PayeeGuard account. Defaults to QDay's own bundler; pass our Alto URL as a fallback
 * (tools/alto) if it is down.
 */
export function createPayeeGuardBundlerClient(params: {
  account: SmartAccount;
  client: AnyClient;
  bundlerUrl?: string;
}) {
  return createBundlerClient({
    account: params.account,
    client: params.client,
    transport: http(params.bundlerUrl ?? QDAY_BUNDLER_URL),
    userOperation: {
      estimateFeesPerGas: async ({ bundlerClient }): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> =>
        estimateUserOpFees(params.client, bundlerClient as never),
    },
  });
}
