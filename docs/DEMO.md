# Demo script (3-5 minutes)

Before recording (about 15 minutes, once):
1. One tUSD8 top-up from the faucet to DEPLOYER (the demo spends about 0.2 tUSD8).
2. `cd sdk && npx tsx examples/make-invoices.ts ../assistant/examples` (fresh invoices, 14-day expiry).
3. `cd assistant && pnpm grant` (fresh session key for the assistant).
4. Start the web app (`cd web && pnpm dev`), MetaMask on Aevum testnet with the PAYER_OWNER account imported for
   the revoke beat, and an explorer tab.

## 0:00 Problem (20 s)
"Our bank details have changed" is the most expensive invoice fraud. Banks have Confirmation of Payee; stablecoin
payments are instant and final and have none. And AI assistants that pay invoices can be talked into anything.

## 0:20 Lead 1: the change is the attack (70 s)
- Web app, **Check & pay**: paste `assistant/examples/fake.txt`. Red: "Do not pay". Point at the payout address
  history: the new address was added minutes ago, still cooling off or cancelled. The invoice signature is valid,
  so a name check alone would have passed it.
- Paste `legit.txt`: green, "Safe to pay", identity card shows Forela's ERC-8004 registration matches.
  Optional: pay with MetaMask (one permit signature + one transaction), open the explorer link.
- **Business** tab (owner wallet): add a payout address, show the live cooling-off countdown and the Cancel button.

## 1:30 Lead 2: an agent with a real session key (90 s)
Terminal, `assistant/`:
- `pnpm pay examples/legit.txt` -> PAY, explorer link (paid through QDay's bundler, gas in tUSD8).
- `pnpm pay examples/injection.txt` -> two warnings (injected instruction, foreign address ignored), pays the
  signed payee only.
- `pnpm pay examples/big.txt` -> ASK_OWNER (over the 0.10 cap).
- `pnpm pay examples/big.txt --ignore-policy` -> "a compromised assistant sends anyway": rejected at validation by the
  account, `SessionPerPaymentCapExceeded`. Nothing reached the chain.
- Web app, **Agent account**: balances (0 tQDAY, gas credit in tUSD8), the session's caps and today's spend, the
  audit trail of agent payments.

## 3:00 Revoke (30 s)
- Agent account tab as owner: **Revoke** -> MetaMask signs the UserOp -> QDay bundler -> done.
- `pnpm pay examples/legit.txt` -> rejected at validation: `SessionNotActive`.

## 3:30 How it is built (40 s)
- Contracts: ERC-8004 identity (official), PayeeRegistry, InvoicePay, ERC-4337 v0.7 account with the policy in
  validateUserOp, tUSD8 paymaster. 88 Foundry tests, SDK and assistant tests.
- Runs on QDay's own bundler in ERC-7562 safe mode; notes on Aevum specifics (Shanghai EVM, getLogs cap, explorer
  verifier) in the README.

## 4:10 Close (20 s)
Business model: per-check fee for payers, free registry for businesses, SDK for invoicing tools and agent
frameworks. Next: mainnet, oracle-priced paymaster, Kernel module, change notifications.
