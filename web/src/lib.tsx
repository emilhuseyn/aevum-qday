import { useEffect, useState, type ReactNode } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  hexToString,
  http,
  type Address,
  type Hex,
  type LocalAccount,
  type SignableMessage,
  type WalletClient,
} from "viem";
import { TUSD8, aevumTestnet, explainError, explorerAddress, explorerTx } from "@payeeguard/sdk";

export const publicClient = createPublicClient({ chain: aevumTestnet, transport: http() });

export type Wallet = { client: WalletClient; address: Address };

export async function connectWallet(): Promise<Wallet> {
  const eth = (window as unknown as { ethereum?: unknown }).ethereum;
  if (!eth) throw new Error("No browser wallet found. Install MetaMask to sign; checking an invoice works without one.");
  const client = createWalletClient({ chain: aevumTestnet, transport: custom(eth as never) });
  const [address] = await client.requestAddresses();
  try {
    await client.switchChain({ id: aevumTestnet.id });
  } catch {
    await client.addChain({ chain: aevumTestnet });
    await client.switchChain({ id: aevumTestnet.id });
  }
  return { client, address };
}

/** Lets a browser wallet act as the owner signer of a PayeeGuard smart account (personal_sign / signTypedData). */
export function walletAsOwner(wallet: Wallet): LocalAccount {
  return {
    address: wallet.address,
    type: "local",
    source: "browser-wallet",
    publicKey: "0x",
    signMessage: ({ message }: { message: SignableMessage }) => wallet.client.signMessage({ account: wallet.address, message }),
    signTypedData: (td: object) => wallet.client.signTypedData({ account: wallet.address, ...td } as never),
    signTransaction: () => {
      throw new Error("not used");
    },
  } as unknown as LocalAccount;
}

/** Recent-window event scans keep the browser to a handful of 1000-block getLogs calls. */
export const RECENT_BLOCKS = 20_000n;
export async function recentFromBlock(deployBlock: bigint) {
  const latest = await publicClient.getBlockNumber();
  return latest - RECENT_BLOCKS > deployBlock ? latest - RECENT_BLOCKS : deployBlock;
}

export const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
export const usd8 = (x: bigint) => `${formatUnits(x, 6)} tUSD8`;
export const amountOf = (token: Address, x: bigint) =>
  token.toLowerCase() === TUSD8.toLowerCase() ? usd8(x) : `${x.toString()} units of ${short(token)}`;
export const utc = (t: bigint | number) =>
  Number(t) === 0 ? "never" : new Date(Number(t) * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";

export function reference(invoiceId: Hex): string {
  try {
    const s = hexToString(invoiceId, { size: 32 }).replace(/\0+$/, "");
    if (/^[\x20-\x7e]+$/.test(s)) return s;
  } catch {}
  return short(invoiceId);
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function duration(seconds: number) {
  if (seconds <= 0) return "now";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h} h ${m} min` : m ? `${m} min ${s} s` : `${s} s`;
}

export function ago(t: bigint | number, now: number) {
  const s = now - Number(t);
  return s < 0 ? `in ${duration(-s)}` : `${duration(s)} ago`;
}

export const errorText = (e: unknown) => explainError(e).message;

export function TxLink({ hash, label }: { hash?: string; label?: string }) {
  if (!hash) return null;
  return (
    <a href={explorerTx(hash)} target="_blank" rel="noreferrer" className="mono">
      {label ?? short(hash)} ↗
    </a>
  );
}

export function AddrLink({ address }: { address?: string }) {
  if (!address) return null;
  return (
    <a href={explorerAddress(address)} target="_blank" rel="noreferrer" className="mono" title={address}>
      {short(address)} ↗
    </a>
  );
}

export function Card({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="card">
      <header>
        <h2>{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

export type Tone = "ok" | "bad" | "warn" | "muted";
export function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`chip ${tone}`}>{children}</span>;
}

export function Banner({ tone, title, children }: { tone: Tone; title: string; children?: ReactNode }) {
  return (
    <div className={`banner ${tone}`} role="status">
      <strong>{title}</strong>
      {children && <div>{children}</div>}
    </div>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => live && setState({ data, loading: false }),
      (e) => live && setState({ error: errorText(e), loading: false }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
