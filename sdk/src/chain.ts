import { defineChain, type Address, type Chain } from "viem";
import { deployments } from "./deployments.js";

export const AEVUM_TESTNET_RPC = "https://rpc-test.qday.info";
/** QDay's own ERC-4337 bundler (rundler, safe mode). Live on testnet, not yet listed in the docs (16 Nov 2026). */
export const QDAY_BUNDLER_URL = "https://bundler.qday.info";
export const ENTRY_POINT_V07: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
/** tUSD8, the Aevum testnet stablecoin (6 decimals, EIP-2612). */
export const TUSD8: Address = "0x456569838f1d43009A91ebA4263147Afd7233483";
export const TUSD8_DECIMALS = 6;
/** QDay's RPC caps eth_getLogs at 1000 blocks per query. */
export const MAX_LOG_RANGE = 999n;

export const aevumTestnet: Chain = defineChain({
  id: 44005,
  name: "QDay Aevum Testnet",
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: [AEVUM_TESTNET_RPC], webSocket: ["wss://rpc-test.qday.info"] } },
  blockExplorers: { default: { name: "Aevum explorer", url: "https://explorer-test.qday.info" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

export type PayeeGuardAddresses = {
  identityRegistry: Address;
  payeeRegistry: Address;
  invoicePay: Address;
  accountFactory: Address;
  entryPoint: Address;
};

export function payeeGuardAddresses(chainId: number = aevumTestnet.id): PayeeGuardAddresses {
  const d = (deployments as Record<string, Record<string, unknown>>)[String(chainId)];
  if (!d) throw new Error(`PayeeGuard is not deployed on chain ${chainId}`);
  return {
    identityRegistry: d.identityRegistry as Address,
    payeeRegistry: d.payeeRegistry as Address,
    invoicePay: d.invoicePay as Address,
    accountFactory: d.accountFactory as Address,
    entryPoint: (d.entryPoint as Address) ?? ENTRY_POINT_V07,
  };
}

export const EXPLORER_URL = "https://explorer-test.qday.info";
export const explorerTx = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
export const explorerAddress = (address: string) => `${EXPLORER_URL}/address/${address}`;
