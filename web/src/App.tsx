import { useEffect, useState } from "react";
import { payeeGuardAddresses } from "@payeeguard/sdk";
import { AddrLink, Banner, connectWallet, errorText, short, type Wallet } from "./lib";
import { PayerView } from "./views/PayerView";
import { BusinessView } from "./views/BusinessView";
import { AgentView } from "./views/AgentView";

const TABS = [
  { id: "pay", label: "Check & pay" },
  { id: "business", label: "Business" },
  { id: "agent", label: "Agent account" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const addresses = payeeGuardAddresses();

export function App() {
  const [tab, setTab] = useState<Tab>(() => (location.hash.slice(1) as Tab) || "pay");
  const [wallet, setWallet] = useState<Wallet>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const onHash = () => setTab((location.hash.slice(1) as Tab) || "pay");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  async function connect() {
    setError(undefined);
    try {
      setWallet(await connectWallet());
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
            <path d="M16 2 4 7v8c0 7.5 5.1 13.4 12 15 6.9-1.6 12-7.5 12-15V7L16 2z" fill="currentColor" />
            <path d="m10.5 16.2 3.6 3.6 7.4-7.4" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div>
            <h1>PayeeGuard</h1>
            <p>Confirmation of payee for stablecoin invoices · QDay Aevum testnet</p>
          </div>
        </div>
        <button className={wallet ? "ghost" : "primary"} onClick={connect}>
          {wallet ? `Connected ${short(wallet.address)}` : "Connect wallet"}
        </button>
      </header>
      {error && <Banner tone="warn" title="Wallet">{error}</Banner>}
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <a key={t.id} href={`#${t.id}`} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "tab active" : "tab"}>
            {t.label}
          </a>
        ))}
      </nav>
      <main>
        {tab === "pay" && <PayerView wallet={wallet} />}
        {tab === "business" && <BusinessView wallet={wallet} />}
        {tab === "agent" && <AgentView wallet={wallet} />}
      </main>
      <footer>
        <span>Testnet only (chain 44005, tUSD8).</span>
        <span><a href="/demo.html">Demo video</a></span>
        <span>ERC-8004 <AddrLink address={addresses.identityRegistry} /></span>
        <span>PayeeRegistry <AddrLink address={addresses.payeeRegistry} /></span>
        <span>InvoicePay <AddrLink address={addresses.invoicePay} /></span>
        <span>Paymaster <AddrLink address={addresses.paymaster} /></span>
      </footer>
    </div>
  );
}
