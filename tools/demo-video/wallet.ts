// Test wallet for driving the web app in headless Chrome: an EIP-1193 provider whose signing runs in this Node process
// with a testnet key from the repo's git-ignored .env. The page only ever sees addresses, signatures and tx hashes.
import { createPublicClient, createWalletClient, http, type Hex, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Page } from "playwright-core";
import { aevumTestnet } from "../../sdk/src/index.js";

process.loadEnvFile(new URL("../../.env", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

export const keyAccount = (name: string): PrivateKeyAccount => {
  const key = process.env[`${name}_KEY`]?.trim();
  if (!key) throw new Error(`${name}_KEY missing in .env`);
  return privateKeyToAccount(key as Hex);
};

export const publicClient = createPublicClient({ chain: aevumTestnet, transport: http() });

const PAGE_SIDE = `
  window.ethereum = {
    isPayeeGuardTestWallet: true,
    request: async ({ method, params }) => {
      const out = JSON.parse(await window.__testWallet(JSON.stringify({ method, params: params ?? [] })));
      if (out.error) throw Object.assign(new Error(out.error.message), { code: out.error.code ?? -32603 });
      return out.result;
    },
    on() {},
    removeListener() {},
  };
`;

const big = (_: string, v: unknown) => (typeof v === "bigint" ? `0x${v.toString(16)}` : v);

/** Installs the provider on the page; `current()` picks the account at call time, so a scene can switch roles. */
export async function installTestWallet(page: Page, current: () => PrivateKeyAccount, log: (m: string) => void = () => {}) {
  await page.exposeFunction("__testWallet", async (raw: string) => {
    const { method, params } = JSON.parse(raw) as { method: string; params: any[] };
    const account = current();
    const wallet = createWalletClient({ account, chain: aevumTestnet, transport: http() });
    try {
      let result: unknown;
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          result = [account.address];
          break;
        case "eth_chainId":
          result = `0x${aevumTestnet.id.toString(16)}`;
          break;
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
          result = null;
          break;
        case "personal_sign":
          result = await account.signMessage({ message: { raw: params[0] as Hex } });
          log(`signed a message as ${account.address}`);
          break;
        case "eth_signTypedData_v4": {
          const td = JSON.parse(params[1]);
          const { EIP712Domain: _, ...types } = td.types;
          result = await account.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message });
          log(`signed typed data ${td.primaryType} as ${account.address}`);
          break;
        }
        case "eth_sendTransaction": {
          const tx = params[0];
          result = await wallet.sendTransaction({
            to: tx.to,
            data: tx.data,
            value: tx.value ? BigInt(tx.value) : undefined,
            gas: tx.gas ? BigInt(tx.gas) : undefined,
          } as never);
          log(`sent ${result} from ${account.address}`);
          break;
        }
        default:
          result = await publicClient.request({ method: method as never, params: params as never });
      }
      return JSON.stringify({ result }, big);
    } catch (e) {
      const err = e as { message?: string; shortMessage?: string; code?: number };
      log(`wallet error on ${method}: ${err.shortMessage ?? err.message}`);
      return JSON.stringify({ error: { message: err.shortMessage ?? err.message ?? String(e), code: err.code } });
    }
  });
  await page.addInitScript(PAGE_SIDE);
}
