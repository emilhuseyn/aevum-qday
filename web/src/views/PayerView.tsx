import { useMemo, useState } from "react";
import { erc20Abi, parseSignature, zeroAddress, type Address, type Hex } from "viem";
import {
  TUSD8,
  checkInvoice,
  findSignedInvoice,
  getBusinessIdentity,
  getPayeeHistory,
  getPayeeInfo,
  invoicePayAbi,
  payeeGuardAddresses,
  type SignedInvoice,
} from "@payeeguard/sdk";
import {
  AddrLink,
  Banner,
  Card,
  Chip,
  TxLink,
  ago,
  amountOf,
  errorText,
  publicClient,
  recentFromBlock,
  reference,
  useAsync,
  useNow,
  utc,
  type Tone,
  type Wallet,
} from "../lib";

const addresses = payeeGuardAddresses();

const statusTone: Record<string, Tone> = {
  Active: "ok",
  CoolingOff: "bad",
  AwaitingApproval: "warn",
  Revoked: "bad",
  None: "bad",
};

export function PayerView({ wallet }: { wallet?: Wallet }) {
  const [text, setText] = useState("");
  const parsed = useMemo((): { signed?: SignedInvoice; error?: string } => {
    if (!text.trim()) return {};
    try {
      const signed = findSignedInvoice(text);
      return signed ? { signed } : { error: "No PayeeGuard invoice found in this text. A signed invoice starts with -----BEGIN PAYEEGUARD INVOICE-----." };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [text]);

  async function onFile(file?: File) {
    if (file) setText(await file.text());
  }

  return (
    <div className="stack">
      <Card title="Check an invoice before you pay">
        <p className="muted">
          Paste the invoice email, or drop the invoice file. PayeeGuard checks the business's on-chain identity, its
          signature, and whether the payout address is registered and past its cooling-off. Nothing is sent until you
          press Pay.
        </p>
        <div
          className="drop"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            onFile(e.dataTransfer.files[0]);
          }}
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste the email or the -----BEGIN PAYEEGUARD INVOICE----- block here, or drop a .json file"
            rows={7}
            aria-label="Invoice text"
          />
          <label className="file">
            <input type="file" accept=".json,.txt,.eml" onChange={(e) => onFile(e.target.files?.[0])} />
            Choose file
          </label>
        </div>
        {parsed.error && <Banner tone="warn" title="Cannot read this invoice">{parsed.error}</Banner>}
      </Card>
      {parsed.signed && <InvoiceCheck signed={parsed.signed} wallet={wallet} key={parsed.signed.signature} />}
    </div>
  );
}

function InvoiceCheck({ signed, wallet }: { signed: SignedInvoice; wallet?: Wallet }) {
  const inv = signed.invoice;
  const now = useNow();
  const payer = wallet?.address ?? (inv.payer !== zeroAddress ? inv.payer : zeroAddress);
  const [refresh, setRefresh] = useState(0);
  const check = useAsync(() => checkInvoice(publicClient, { invoice: inv, signature: signed.signature, payer }), [payer, refresh]);
  const identity = useAsync(() => getBusinessIdentity(publicClient, inv.payeeAgentId), [inv.payeeAgentId, refresh]);
  const payee = useAsync(() => getPayeeInfo(publicClient, inv.payeeAgentId, inv.payTo), [inv.payTo, refresh]);
  const history = useAsync(async () => {
    const fromBlock = await recentFromBlock(addresses.deployBlock);
    const events = await getPayeeHistory(publicClient, inv.payeeAgentId, { fromBlock });
    const withTimes = await Promise.all(
      events.slice(-8).map(async (e) => ({ ...e, time: (await publicClient.getBlock({ blockNumber: e.blockNumber })).timestamp })),
    );
    return withTimes.reverse();
  }, [inv.payeeAgentId, refresh]);

  const [pay, setPay] = useState<{ busy?: boolean; hash?: Hex; error?: string }>({});

  async function payNow() {
    if (!wallet) return;
    setPay({ busy: true });
    try {
      // checkInvoice above already ran the same checks InvoicePay will run; the button is enabled only when Payable.
      const hash = await payWithPermit(wallet, signed);
      setPay({ busy: true, hash });
      await publicClient.waitForTransactionReceipt({ hash });
      setPay({ hash });
      setRefresh((r) => r + 1);
    } catch (e) {
      setPay({ error: errorText(e) });
    }
  }

  const v = check.data;
  const tone: Tone = !v ? "muted" : v.ok ? "ok" : "bad";
  const name = identity.data?.registration?.name;

  return (
    <>
      <Card
        title="Verdict"
        aside={<button className="ghost" onClick={() => setRefresh((r) => r + 1)}>Re-check</button>}
      >
        {check.loading && !v && <p className="muted">Checking on Aevum…</p>}
        {check.error && <Banner tone="warn" title="Check failed">{check.error}</Banner>}
        {v && (
          <Banner tone={tone} title={v.ok ? "Safe to pay" : "Do not pay"}>
            {v.message}
          </Banner>
        )}
        <dl className="facts">
          <dt>Amount</dt>
          <dd className="big">{amountOf(inv.token, inv.amount)}</dd>
          <dt>Reference</dt>
          <dd>{signed.display?.reference ?? reference(inv.invoiceId)}</dd>
          <dt>Pay to</dt>
          <dd>
            <AddrLink address={inv.payTo} />{" "}
            {payee.data && <Chip tone={statusTone[payee.data.status]}>{payee.data.status === "None" ? "Not registered" : payee.data.status}</Chip>}
          </dd>
          {payee.data && payee.data.requestedAt > 0n && (
            <>
              <dt>Address added</dt>
              <dd>
                {utc(payee.data.requestedAt)} ({ago(payee.data.requestedAt, now)})
                {payee.data.status === "CoolingOff" && <> · payable {ago(payee.data.activeAt, now)}</>}
              </dd>
            </>
          )}
          <dt>Due</dt>
          <dd>{inv.dueBy === 0n ? "no expiry" : utc(inv.dueBy)}</dd>
          {signed.display?.description && (
            <>
              <dt>Description (unverified)</dt>
              <dd>{signed.display.description}</dd>
            </>
          )}
        </dl>
        {wallet ? (
          <button className="primary" disabled={!v?.ok || pay.busy} onClick={payNow}>
            {pay.busy ? "Paying…" : `Pay ${amountOf(inv.token, inv.amount)}`}
          </button>
        ) : (
          <p className="muted">Connect a wallet to pay. The check above works without one.</p>
        )}
        {pay.hash && (
          <Banner tone="ok" title={pay.busy ? "Submitted" : "Paid: receipt on chain"}>
            <TxLink hash={pay.hash} label="View transaction" />
          </Banner>
        )}
        {pay.error && <Banner tone="bad" title="Payment refused">{pay.error}</Banner>}
      </Card>

      <div className="grid2">
        <Card title="Business identity (ERC-8004)">
          {identity.error && <p className="muted">{identity.error}</p>}
          {identity.data && (
            <dl className="facts">
              <dt>Name</dt>
              <dd>
                {name ?? "(no registration file)"}{" "}
                {identity.data.registrationMatches ? <Chip tone="ok">registration file matches</Chip> : <Chip tone="warn">unverified name</Chip>}
              </dd>
              <dt>Agent</dt>
              <dd>#{inv.payeeAgentId.toString()}</dd>
              <dt>Owner</dt>
              <dd>
                <AddrLink address={identity.data.owner} />
              </dd>
              {identity.data.domain && (
                <>
                  <dt>Served from</dt>
                  <dd>{identity.data.domain}</dd>
                </>
              )}
            </dl>
          )}
          {signed.display?.businessName && signed.display.businessName !== name && (
            <Banner tone="warn" title="Name mismatch">
              The invoice says “{signed.display.businessName}”, the on-chain identity says “{name ?? "nothing"}”.
            </Banner>
          )}
        </Card>
        <Card title="Payout address history">
          {history.loading && <p className="muted">Reading PayeeRegistry events…</p>}
          {history.data?.length === 0 && <p className="muted">No changes in the recent window.</p>}
          <ul className="timeline">
            {history.data?.map((e) => (
              <li key={e.transactionHash + e.event}>
                <span className="when">{ago(e.time, now)}</span>{" "}
                <strong>{e.event.replace("PayeeChange", "").replace("PayeeRevoked", "Revoked")}</strong>{" "}
                <AddrLink address={e.payee} /> <TxLink hash={e.transactionHash} label="tx" />
                {e.payee.toLowerCase() === inv.payTo.toLowerCase() && <Chip tone="muted">this invoice</Chip>}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

/** One signature (EIP-2612 permit for exactly the amount) + one transaction. Falls back to approve + pay. */
async function payWithPermit(wallet: Wallet, signed: SignedInvoice): Promise<Hex> {
  const inv = signed.invoice;
  const token = inv.token as Address;
  const owner = wallet.address;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  if (token.toLowerCase() === TUSD8.toLowerCase()) {
    try {
      const [name, nonce] = await Promise.all([
        publicClient.readContract({ address: token, abi: erc20Abi, functionName: "name" }),
        publicClient.readContract({
          address: token,
          abi: [{ type: "function", name: "nonces", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
          functionName: "nonces",
          args: [owner],
        }),
      ]);
      const sig = await wallet.client.signTypedData({
        account: owner,
        domain: { name, version: "2", chainId: publicClient.chain!.id, verifyingContract: token },
        types: {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "Permit",
        message: { owner, spender: addresses.invoicePay, value: inv.amount, nonce, deadline },
      });
      const { r, s, v, yParity } = parseSignature(sig);
      return await wallet.client.writeContract({
        account: owner,
        chain: publicClient.chain,
        address: addresses.invoicePay,
        abi: invoicePayAbi,
        functionName: "payInvoiceWithPermit",
        args: [inv, signed.signature, deadline, Number(v ?? BigInt(27 + (yParity ?? 0))), r, s],
      });
    } catch (e) {
      if (/denied|rejected/i.test(String((e as Error).message))) throw e;
    }
  }
  const approve = await wallet.client.writeContract({
    account: owner,
    chain: publicClient.chain,
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [addresses.invoicePay, inv.amount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approve });
  return wallet.client.writeContract({
    account: owner,
    chain: publicClient.chain,
    address: addresses.invoicePay,
    abi: invoicePayAbi,
    functionName: "payInvoice",
    args: [inv, signed.signature],
  });
}
