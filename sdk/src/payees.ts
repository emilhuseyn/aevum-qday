import { getAbiItem, type Address, type Log, type PublicClient } from "viem";
import { payeeRegistryAbi } from "./abis.js";
import { MAX_LOG_RANGE, payeeGuardAddresses } from "./chain.js";

export const PAYEE_STATUS = ["None", "AwaitingApproval", "CoolingOff", "Active", "Revoked"] as const;
export type PayeeStatus = (typeof PAYEE_STATUS)[number];

export type PayeeInfo = {
  status: PayeeStatus;
  requestedAt: bigint;
  activeAt: bigint;
  revokedAt: bigint;
  approved: boolean;
};

export async function getPayeeInfo(client: PublicClient, agentId: bigint, payee: Address): Promise<PayeeInfo> {
  const [status, info] = await client.readContract({
    address: payeeGuardAddresses(client.chain?.id).payeeRegistry,
    abi: payeeRegistryAbi,
    functionName: "payeeInfo",
    args: [agentId, payee],
  });
  return {
    status: PAYEE_STATUS[status],
    requestedAt: info.requestedAt,
    activeAt: info.activeAt,
    revokedAt: info.revokedAt,
    approved: info.approved,
  };
}

/** eth_getLogs in windows of at most 1000 blocks (QDay's RPC limit). */
export async function getLogsPaged<T>(
  fetch: (range: { fromBlock: bigint; toBlock: bigint }) => Promise<T[]>,
  fromBlock: bigint,
  toBlock: bigint,
  step: bigint = MAX_LOG_RANGE,
): Promise<T[]> {
  const out: T[] = [];
  for (let start = fromBlock; start <= toBlock; start += step + 1n) {
    const end = start + step > toBlock ? toBlock : start + step;
    out.push(...(await fetch({ fromBlock: start, toBlock: end })));
  }
  return out;
}

const PAYEE_EVENTS = [
  "PayeeChangeRequested",
  "PayeeChangeApproved",
  "PayeeChangeCancelled",
  "PayeeChangeActivated",
  "PayeeRevoked",
] as const;

export type PayeeEvent = {
  event: (typeof PAYEE_EVENTS)[number];
  payee: Address;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
  args: Record<string, unknown>;
};

/** Payout-address history of a business (the audit trail the assistant shows: "address changed 5 minutes ago"). */
export async function getPayeeHistory(
  client: PublicClient,
  agentId: bigint,
  opts: { fromBlock: bigint; toBlock?: bigint },
): Promise<PayeeEvent[]> {
  const address = payeeGuardAddresses(client.chain?.id).payeeRegistry;
  const toBlock = opts.toBlock ?? (await client.getBlockNumber());
  const events = PAYEE_EVENTS.map((name) => getAbiItem({ abi: payeeRegistryAbi, name }));
  const logs = await getLogsPaged(
    (range) => client.getLogs({ address, events, args: { agentId } as never, ...range }) as Promise<Log[]>,
    opts.fromBlock,
    toBlock,
  );
  return logs
    .map((l) => {
      const log = l as unknown as { eventName: PayeeEvent["event"]; args: Record<string, unknown>; blockNumber: bigint; transactionHash: `0x${string}` };
      return {
        event: log.eventName,
        payee: log.args.payee as Address,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        args: log.args,
      };
    })
    .sort((a, b) => Number(a.blockNumber - b.blockNumber));
}
