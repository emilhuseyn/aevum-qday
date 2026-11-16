import { useEffect, useState } from "react";
import { isAddress, parseEventLogs, parseUnits, zeroAddress, type Address, type Hex } from "viem";
import {
  TUSD8,
  getPayeeInfo,
  identityRegistryAbi,
  makeInvoice,
  payeeGuardAddresses,
  payeeRegistryAbi,
  serializeSignedInvoice,
  signInvoice,
  signedInvoiceBlock,
  toSignedInvoice,
  type PayeeInfo,
} from "@payeeguard/sdk";
import {
  AddrLink,
  Banner,
  Card,
  Chip,
  TxLink,
  ago,
  duration,
  errorText,
  publicClient,
  useNow,
  utc,
  walletAsOwner,
  type Tone,
  type Wallet,
} from "../lib";

const addresses = payeeGuardAddresses();
const STORAGE_KEY = "payeeguard.agents";
const AGENT_BATCH = 20n;
const MAX_AGENT_SCAN = 2_000n;

function rememberAgent(owner: Address, id: bigint) {
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    all[owner] = [...new Set([...(all[owner] ?? []), id.toString()])];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {}
}
function rememberedAgents(owner: Address): bigint[] {
  try {
    return (JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")[owner] ?? []).map(BigInt);
  } catch {
    return [];
  }
}

function registrationUri(name: string, website: string, agentId?: bigint) {
  const file = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name,
    description: `${name} receives stablecoin payments through PayeeGuard. Pay only to payout addresses active in PayeeRegistry.`,
    image: "",
    services: website ? [{ name: "web", endpoint: website }] : [],
    active: true,
    registrations:
      agentId === undefined ? [] : [{ agentId: Number(agentId), agentRegistry: `eip155:44005:${addresses.identityRegistry}` }],
    supportedTrust: [],
  };
  return `data:application/json;base64,${btoa(JSON.stringify(file))}`;
}

type Tx = { busy?: string; hash?: Hex; error?: string };

export function BusinessView({ wallet }: { wallet?: Wallet }) {
  const [agents, setAgents] = useState<bigint[]>([]);
  const [selected, setSelected] = useState<bigint>();
  const [manual, setManual] = useState("");

  useEffect(() => {
    if (!wallet) return;
    let live = true;
    (async () => {
      // ERC-8004 agent ids are minted in order from 0, so walking ownerOf until the first unminted id finds every
      // identity this wallet owns, however old (an event scan would hit Aevum's 1000-block getLogs cap).
      const ownerOf = (id: bigint) =>
        publicClient
          .readContract({ address: addresses.identityRegistry, abi: identityRegistryAbi, functionName: "ownerOf", args: [id] })
          .catch(() => undefined);
      const mine = (o?: Address) => o?.toLowerCase() === wallet.address.toLowerCase();
      const owned = new Set<bigint>();
      for (let start = 0n; start < MAX_AGENT_SCAN; start += AGENT_BATCH) {
        const batch = await Promise.all(Array.from({ length: Number(AGENT_BATCH) }, (_, i) => ownerOf(start + BigInt(i))));
        batch.forEach((o, i) => mine(o) && owned.add(start + BigInt(i)));
        if (batch.includes(undefined)) break;
      }
      for (const id of rememberedAgents(wallet.address)) if (!owned.has(id) && mine(await ownerOf(id))) owned.add(id);
      if (live) {
        const sorted = [...owned].sort((a, b) => Number(a - b));
        setAgents(sorted);
        setSelected((s) => s ?? sorted[0]);
      }
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [wallet]);

  if (!wallet) {
    return (
      <Card title="For businesses">
        <p className="muted">
          Connect the wallet that owns your business identity. You register once (ERC-8004), add your payout address
          (it becomes payable after the cooling-off), and sign invoices your customers can verify.
        </p>
      </Card>
    );
  }

  return (
    <div className="stack">
      <Card title="Your business identities">
        {agents.length === 0 && <p className="muted">No identity found for {wallet.address.slice(0, 8)}… in the recent window.</p>}
        <div className="row">
          {agents.map((id) => (
            <button key={id.toString()} className={selected === id ? "tab active" : "tab"} onClick={() => setSelected(id)}>
              Agent #{id.toString()}
            </button>
          ))}
          <input placeholder="agent id" value={manual} onChange={(e) => setManual(e.target.value)} style={{ width: 100 }} />
          <button className="ghost" disabled={!/^\d+$/.test(manual)} onClick={() => setSelected(BigInt(manual))}>
            Open
          </button>
        </div>
        <Register wallet={wallet} onRegistered={(id) => (rememberAgent(wallet.address, id), setAgents((a) => [...a, id]), setSelected(id))} />
      </Card>
      {selected !== undefined && <Agent wallet={wallet} agentId={selected} key={selected.toString()} />}
    </div>
  );
}

function Register({ wallet, onRegistered }: { wallet: Wallet; onRegistered: (id: bigint) => void }) {
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [tx, setTx] = useState<Tx>({});
  async function register() {
    try {
      setTx({ busy: "Registering identity…" });
      const hash = await wallet.client.writeContract({
        account: wallet.address,
        chain: publicClient.chain,
        address: addresses.identityRegistry,
        abi: identityRegistryAbi,
        functionName: "register",
        args: [registrationUri(name, website)],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const [registered] = parseEventLogs({ abi: identityRegistryAbi, eventName: "Registered", logs: receipt.logs });
      const agentId = registered.args.agentId;
      // Second step: the registration file names its own agentId (ERC-8004 "registrations"), so anyone can match it.
      setTx({ busy: "Linking the registration file to agent #" + agentId, hash });
      const hash2 = await wallet.client.writeContract({
        account: wallet.address,
        chain: publicClient.chain,
        address: addresses.identityRegistry,
        abi: identityRegistryAbi,
        functionName: "setAgentURI",
        args: [agentId, registrationUri(name, website, agentId)],
      });
      await publicClient.waitForTransactionReceipt({ hash: hash2 });
      setTx({ hash: hash2 });
      onRegistered(agentId);
    } catch (e) {
      setTx({ error: errorText(e) });
    }
  }
  return (
    <details className="sub">
      <summary>Register a new business identity</summary>
      <div className="form">
        <input placeholder="Business name" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="Website (optional)" value={website} onChange={(e) => setWebsite(e.target.value)} />
        <button className="primary" disabled={!name || !!tx.busy} onClick={register}>
          Register on ERC-8004
        </button>
      </div>
      <TxStatus tx={tx} />
    </details>
  );
}

function TxStatus({ tx }: { tx: Tx }) {
  if (tx.error) return <Banner tone="bad" title="Refused">{tx.error}</Banner>;
  if (tx.busy) return <p className="muted">{tx.busy} {tx.hash && <TxLink hash={tx.hash} />}</p>;
  if (tx.hash) return <p className="muted">Done: <TxLink hash={tx.hash} /></p>;
  return null;
}

const tones: Record<PayeeInfo["status"], Tone> = { None: "muted", AwaitingApproval: "warn", CoolingOff: "warn", Active: "ok", Revoked: "bad" };

function Agent({ wallet, agentId }: { wallet: Wallet; agentId: bigint }) {
  const now = useNow();
  const [payees, setPayees] = useState<(PayeeInfo & { address: Address })[]>([]);
  const [policy, setPolicy] = useState<{ coolingOff: number; guardian: Address }>();
  const [refresh, setRefresh] = useState(0);
  const [tx, setTx] = useState<Tx>({});
  const [newPayee, setNewPayee] = useState("");

  useEffect(() => {
    let live = true;
    (async () => {
      const list = await publicClient.readContract({ address: addresses.payeeRegistry, abi: payeeRegistryAbi, functionName: "payeesOf", args: [agentId] });
      const infos = await Promise.all(list.map(async (a) => ({ address: a, ...(await getPayeeInfo(publicClient, agentId, a)) })));
      const [coolingOff, guardian] = await publicClient.readContract({ address: addresses.payeeRegistry, abi: payeeRegistryAbi, functionName: "policyOf", args: [agentId] });
      if (live) {
        setPayees(infos);
        setPolicy({ coolingOff, guardian });
      }
    })().catch((e) => live && setTx({ error: errorText(e) }));
    return () => {
      live = false;
    };
  }, [agentId, refresh]);

  // Re-read once a cooling-off ends so the status flips without a manual refresh.
  useEffect(() => {
    const next = payees.filter((p) => p.status === "CoolingOff").map((p) => Number(p.activeAt) - now);
    if (next.length && Math.min(...next) === 0) setRefresh((r) => r + 1);
  }, [now, payees]);

  async function send(label: string, functionName: "requestPayee" | "cancelPayee" | "revokePayee", payee: Address) {
    try {
      setTx({ busy: label });
      const hash = await wallet.client.writeContract({
        account: wallet.address,
        chain: publicClient.chain,
        address: addresses.payeeRegistry,
        abi: payeeRegistryAbi,
        functionName,
        args: [agentId, payee],
      });
      setTx({ busy: label, hash });
      await publicClient.waitForTransactionReceipt({ hash });
      setTx({ hash });
      setRefresh((r) => r + 1);
    } catch (e) {
      setTx({ error: errorText(e) });
    }
  }

  const active = payees.filter((p) => p.status === "Active");

  return (
    <>
      <Card title={`Payout addresses of agent #${agentId}`} aside={<button className="ghost" onClick={() => setRefresh((r) => r + 1)}>Refresh</button>}>
        <p className="muted">
          A new address is not payable for {policy ? duration(policy.coolingOff) : "…"} after you add it. If you did not
          add it (stolen key, compromised laptop), cancel it inside that window: customers' checks will refuse it.
          {policy && policy.guardian !== zeroAddress && <> A second approver (<AddrLink address={policy.guardian} />) must also approve.</>}
        </p>
        <table>
          <thead>
            <tr>
              <th>Address</th>
              <th>Status</th>
              <th>Added</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {payees.map((p) => (
              <tr key={p.address}>
                <td><AddrLink address={p.address} /></td>
                <td>
                  <Chip tone={tones[p.status]}>{p.status === "CoolingOff" ? `cooling off · ${duration(Number(p.activeAt) - now)}` : p.status === "None" ? "cancelled" : p.status}</Chip>
                </td>
                <td>{p.requestedAt ? ago(p.requestedAt, now) : ""}</td>
                <td className="right">
                  {(p.status === "CoolingOff" || p.status === "AwaitingApproval") && (
                    <button className="danger" onClick={() => send("Cancelling…", "cancelPayee", p.address)}>Cancel</button>
                  )}
                  {p.status === "Active" && (
                    <button className="danger" onClick={() => send("Revoking…", "revokePayee", p.address)}>Revoke</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="form">
          <input placeholder="New payout address 0x…" value={newPayee} onChange={(e) => setNewPayee(e.target.value.trim())} />
          <button className="primary" disabled={!isAddress(newPayee)} onClick={() => send("Adding payout address…", "requestPayee", newPayee as Address)}>
            Add (starts cooling-off)
          </button>
        </div>
        <TxStatus tx={tx} />
      </Card>
      <CreateInvoice wallet={wallet} agentId={agentId} activePayees={active.map((p) => p.address)} />
    </>
  );
}

function CreateInvoice({ wallet, agentId, activePayees }: { wallet: Wallet; agentId: bigint; activePayees: Address[] }) {
  const [form, setForm] = useState({ reference: "", amount: "0.25", payTo: "", payer: "", days: "14", businessName: "", description: "" });
  const [out, setOut] = useState<{ block: string; json: string }>();
  const [error, setError] = useState<string>();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const payTo = form.payTo || activePayees[0];

  async function sign() {
    setError(undefined);
    try {
      const now = Number((await publicClient.getBlock()).timestamp);
      const invoice = makeInvoice({
        reference: form.reference,
        payeeAgentId: agentId,
        payTo: payTo as Address,
        token: TUSD8,
        amount: parseUnits(form.amount, 6),
        payer: isAddress(form.payer) ? form.payer : undefined,
        dueInSeconds: Number(form.days) * 86400,
        details: `${form.businessName} ${form.reference}: ${form.description}`,
        now,
      });
      const signature = await signInvoice(walletAsOwner(wallet), invoice);
      const signed = toSignedInvoice(invoice, signature, {
        businessName: form.businessName || undefined,
        reference: form.reference,
        description: form.description || undefined,
        amount: `${form.amount} tUSD8`,
      });
      setOut({ block: signedInvoiceBlock(signed), json: serializeSignedInvoice(signed) });
    } catch (e) {
      setError(errorText(e));
    }
  }

  function download() {
    if (!out) return;
    const url = URL.createObjectURL(new Blob([out.json], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${form.reference || "invoice"}.payeeguard.json` });
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card title="Sign an invoice">
      {activePayees.length === 0 && <Banner tone="warn" title="No active payout address yet">Add one above and wait for the cooling-off; invoices to a pending address are refused.</Banner>}
      <div className="form grid">
        <label>Reference<input value={form.reference} onChange={set("reference")} placeholder="INV-2026-0042" maxLength={31} /></label>
        <label>Amount (tUSD8)<input value={form.amount} onChange={set("amount")} inputMode="decimal" /></label>
        <label>
          Pay to
          <select value={payTo} onChange={set("payTo")}>
            {activePayees.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label>Due in (days)<input value={form.days} onChange={set("days")} inputMode="numeric" /></label>
        <label>Payer (optional)<input value={form.payer} onChange={set("payer")} placeholder="0x… (anyone if empty)" /></label>
        <label>Business name (shown to payer)<input value={form.businessName} onChange={set("businessName")} /></label>
        <label className="wide">Description<input value={form.description} onChange={set("description")} placeholder="Security review, November" /></label>
      </div>
      <button className="primary" disabled={!form.reference || !payTo || !(Number(form.amount) > 0)} onClick={sign}>
        Sign invoice (EIP-712)
      </button>
      {error && <Banner tone="bad" title="Not signed">{error}</Banner>}
      {out && (
        <div className="stack">
          <p className="muted">Paste this block into your email or PDF. The customer drops it into PayeeGuard before paying.</p>
          <pre className="block">{out.block}</pre>
          <div className="row">
            <button className="ghost" onClick={() => navigator.clipboard.writeText(out.block)}>Copy block</button>
            <button className="ghost" onClick={download}>Download .json</button>
          </div>
        </div>
      )}
    </Card>
  );
}
