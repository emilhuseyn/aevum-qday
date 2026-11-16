import { useState } from "react";
import { erc20Abi, formatEther, getAbiItem, isAddress, type Address, type Hex } from "viem";
import {
  TUSD8,
  createPayeeGuardBundlerClient,
  currentDay,
  getLogsPaged,
  payeeGuardAccountAbi,
  payeeGuardAddresses,
  payeeGuardPaymasterAbi,
  revokeSessionCall,
  toPayeeGuardAccount,
} from "@payeeguard/sdk";
import {
  AddrLink,
  Banner,
  Card,
  Chip,
  TxLink,
  ago,
  errorText,
  publicClient,
  recentFromBlock,
  reference,
  short,
  useAsync,
  useNow,
  usd8,
  utc,
  walletAsOwner,
  type Wallet,
} from "../lib";

const addresses = payeeGuardAddresses();
const DEMO_ACCOUNT = "0x8f37285Ac224546098d59D0C1A9aF09B8C35126F";

export function AgentView({ wallet }: { wallet?: Wallet }) {
  const [input, setInput] = useState(() => localStorage.getItem("payeeguard.account") ?? DEMO_ACCOUNT);
  const account = isAddress(input) ? (input as Address) : undefined;
  return (
    <div className="stack">
      <Card title="Payer smart account (ERC-4337)">
        <p className="muted">
          The AI assistant pays from this account with a session key. Its limits live in the account and are checked
          in validateUserOp, so an over-limit or revoked request is rejected before anything executes. Gas is paid in
          tUSD8 through the PayeeGuard paymaster.
        </p>
        <div className="form">
          <input
            value={input}
            onChange={(e) => {
              setInput(e.target.value.trim());
              try {
                localStorage.setItem("payeeguard.account", e.target.value.trim());
              } catch {}
            }}
            placeholder="Smart account address"
            aria-label="Smart account address"
          />
        </div>
      </Card>
      {account && <AccountPanel account={account} wallet={wallet} key={account} />}
    </div>
  );
}

type Session = {
  key: Address;
  grantId: bigint;
  token: Address;
  perPaymentCap: bigint;
  dailyCap: bigint;
  validAfter: number;
  validUntil: number;
  payeeAgentIds: readonly bigint[];
  active: boolean;
  spentToday: bigint;
  grantTx: Hex;
};

function AccountPanel({ account, wallet }: { account: Address; wallet?: Wallet }) {
  const now = useNow();
  const [refresh, setRefresh] = useState(0);
  const [tx, setTx] = useState<{ busy?: string; hash?: Hex; error?: string }>({});

  const info = useAsync(async () => {
    const [owner, tusd8, native, credit] = await Promise.all([
      publicClient.readContract({ address: account, abi: payeeGuardAccountAbi, functionName: "owner" }),
      publicClient.readContract({ address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
      publicClient.getBalance({ address: account }),
      publicClient.readContract({ address: addresses.paymaster, abi: payeeGuardPaymasterAbi, functionName: "credit", args: [account] }),
    ]);
    return { owner, tusd8, native, credit };
  }, [account, refresh]);

  const activity = useAsync(async () => {
    const fromBlock = await recentFromBlock(addresses.deployBlock);
    const toBlock = await publicClient.getBlockNumber();
    const events = [
      getAbiItem({ abi: payeeGuardAccountAbi, name: "SessionGranted" }),
      getAbiItem({ abi: payeeGuardAccountAbi, name: "SessionRevoked" }),
      getAbiItem({ abi: payeeGuardAccountAbi, name: "InvoicePaidFromAccount" }),
    ];
    const logs = await getLogsPaged((r) => publicClient.getLogs({ address: account, events, ...r }), fromBlock, toBlock);
    const day = await currentDay(publicClient);
    const sessions = new Map<string, Session>();
    for (const l of logs) {
      if (l.eventName === "SessionGranted") {
        const a = l.args as Record<string, never>;
        sessions.set(a.key, {
          key: a.key,
          grantId: a.grantId,
          token: a.token,
          perPaymentCap: a.perPaymentCap,
          dailyCap: a.dailyCap,
          validAfter: Number(a.validAfter),
          validUntil: Number(a.validUntil),
          payeeAgentIds: a.payeeAgentIds,
          active: true,
          spentToday: 0n,
          grantTx: l.transactionHash,
        });
      }
    }
    for (const s of sessions.values()) {
      const cur = await publicClient.readContract({ address: account, abi: payeeGuardAccountAbi, functionName: "sessionOf", args: [s.key] });
      s.active = cur.grantId === s.grantId;
      s.spentToday = await publicClient.readContract({ address: account, abi: payeeGuardAccountAbi, functionName: "spentOn", args: [s.key, day] });
    }
    const payments = logs
      .filter((l) => l.eventName === "InvoicePaidFromAccount")
      .map((l) => ({ ...(l.args as Record<string, never>), tx: l.transactionHash, block: l.blockNumber }))
      .reverse();
    const times = new Map<bigint, bigint>();
    await Promise.all(
      [...new Set(payments.map((p) => p.block))].slice(0, 20).map(async (b) => times.set(b, (await publicClient.getBlock({ blockNumber: b })).timestamp)),
    );
    return { sessions: [...sessions.values()].reverse(), payments: payments.map((p) => ({ ...p, time: times.get(p.block) })) };
  }, [account, refresh]);

  const isOwner = wallet && info.data && wallet.address.toLowerCase() === info.data.owner.toLowerCase();

  async function revoke(key: Address) {
    if (!wallet || !info.data) return;
    try {
      setTx({ busy: "Sign the revocation in your wallet…" });
      const owner = walletAsOwner(wallet);
      const smart = await toPayeeGuardAccount({ client: publicClient, owner, address: account });
      const bundler = createPayeeGuardBundlerClient({ account: smart, client: publicClient, paymaster: true });
      const hash = await bundler.sendUserOperation({ calls: [revokeSessionCall(smart, key)] });
      setTx({ busy: "Revocation submitted to QDay's bundler…" });
      const receipt = await bundler.waitForUserOperationReceipt({ hash, timeout: 120_000 });
      setTx({ hash: receipt.receipt.transactionHash });
      setRefresh((r) => r + 1);
    } catch (e) {
      setTx({ error: errorText(e) });
    }
  }

  return (
    <>
      <Card title="Balances" aside={<button className="ghost" onClick={() => setRefresh((r) => r + 1)}>Refresh</button>}>
        {info.error && <Banner tone="warn" title="Not a PayeeGuard account">{info.error}</Banner>}
        {info.data && (
          <dl className="facts">
            <dt>Account</dt>
            <dd><AddrLink address={account} /></dd>
            <dt>Owner</dt>
            <dd><AddrLink address={info.data.owner} /> {isOwner && <Chip tone="ok">you</Chip>}</dd>
            <dt>tUSD8</dt>
            <dd>{usd8(info.data.tusd8)}</dd>
            <dt>Gas credit</dt>
            <dd>{usd8(info.data.credit)} <span className="muted">(paymaster)</span></dd>
            <dt>tQDAY</dt>
            <dd>{formatEther(info.data.native)} {info.data.native === 0n && <Chip tone="ok">needs none</Chip>}</dd>
          </dl>
        )}
      </Card>
      <Card title="Session keys">
        {activity.loading && <p className="muted">Reading account events…</p>}
        {activity.data?.sessions.length === 0 && <p className="muted">No sessions granted in the recent window.</p>}
        <table>
          <thead>
            <tr><th>Key</th><th>Limits</th><th>Today</th><th>Valid</th><th>Payees</th><th /></tr>
          </thead>
          <tbody>
            {activity.data?.sessions.map((s) => (
              <tr key={s.key + s.grantId}>
                <td><AddrLink address={s.key} /></td>
                <td>{usd8(s.perPaymentCap)} / payment<br />{usd8(s.dailyCap)} / day</td>
                <td>{usd8(s.spentToday)}</td>
                <td>{now > s.validUntil ? <Chip tone="muted">expired</Chip> : `until ${utc(s.validUntil)}`}</td>
                <td>{s.payeeAgentIds.length ? s.payeeAgentIds.map((id) => `#${id}`).join(", ") : "any"}</td>
                <td className="right">
                  {s.active ? (
                    isOwner ? <button className="danger" onClick={() => revoke(s.key)}>Revoke</button> : <Chip tone="ok">active</Chip>
                  ) : (
                    <Chip tone="bad">revoked</Chip>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {tx.busy && <p className="muted">{tx.busy}</p>}
        {tx.hash && <Banner tone="ok" title="Session revoked">The next request signed by that key fails validation. <TxLink hash={tx.hash} /></Banner>}
        {tx.error && <Banner tone="bad" title="Not revoked">{tx.error}</Banner>}
      </Card>
      <Card title="Agent payments (audit trail)">
        {activity.data?.payments.length === 0 && <p className="muted">No payments in the recent window.</p>}
        <ul className="timeline">
          {activity.data?.payments.map((p: any) => (
            <li key={p.tx}>
              <span className="when">{p.time ? ago(p.time, now) : ""}</span> <strong>{usd8(p.amount)}</strong> to business #
              {String(p.payeeAgentId)} · {reference(p.invoiceId)} · session {short(p.sessionKey)} <TxLink hash={p.tx} label="tx" />
            </li>
          ))}
        </ul>
        <p className="muted small">
          Requests the account refused (over a cap, wrong payee, revoked key) never reach the chain: the bundler rejects
          them at validation. The assistant's own log shows those refusals with their reasons.
        </p>
      </Card>
    </>
  );
}
