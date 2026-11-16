// Records the demo video's footage: the live web app driven in headless Chrome with a test wallet, the invoice
// assistant run for real in an on-screen terminal, and title slides. Every transaction is real (Aevum testnet).
//
//   npx tsx record.ts            all scenes, in order (the chain state of one scene feeds the next)
//   SITE=http://localhost:5186   record against a local dev server instead of the live site
//
// Writes out/frames/<scene>/NNNNN.jpg + timeline.json, out/slides/<id>.jpg and out/run.json (tx hashes).
// Then `py build_video.py` adds the narration and captions.
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type CDPSession, type Locator, type Page } from "playwright-core";
import type { PrivateKeyAccount } from "viem";
import { installTestWallet, keyAccount } from "./wallet.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const ASSISTANT = join(ROOT, "assistant");
const OUT = join(HERE, "out");
const SITE = process.env.SITE ?? "https://payeeguard-theta.vercel.app";
const VIEW = { width: 1280, height: 720 };
const run: Record<string, unknown> = { site: SITE, startedAt: new Date().toISOString() };
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

let who: PrivateKeyAccount = keyAccount("BUSINESS");
const attacker = process.env.ATTACKER_ADDR!.trim();

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1.5 });
await installTestWallet(page, () => who, log);
await page.addInitScript(() => {
  addEventListener("DOMContentLoaded", () => {
    const c = document.createElement("div");
    c.id = "__cursor";
    c.style.cssText =
      "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transition:transform .7s cubic-bezier(.3,.7,.3,1);transform:translate(900px,620px)";
    c.innerHTML =
      '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2l15 11-6.5 1 3.6 7.2-2.6 1.3-3.6-7.2L5 20z" fill="#111" stroke="#fff" stroke-width="1.4"/></svg>';
    document.body.appendChild(c);
  });
});
page.on("console", (m) => m.type() === "error" && log(`console: ${m.text()}`));

class Recorder {
  private cdp!: CDPSession;
  private dir = "";
  private frames: { file: string; t: number }[] = [];
  async init() {
    this.cdp = await page.context().newCDPSession(page);
    this.cdp.on("Page.screencastFrame", (f) => {
      const file = `${String(this.frames.length).padStart(5, "0")}.jpg`;
      writeFileSync(join(this.dir, file), Buffer.from(f.data, "base64"));
      this.frames.push({ file, t: f.metadata.timestamp ?? Date.now() / 1000 });
      this.cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
  }
  async start(scene: string) {
    this.dir = join(OUT, "frames", scene);
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    this.frames = [];
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1080 });
    log(`scene ${scene}`);
  }
  async stop() {
    await page.waitForTimeout(400);
    await this.cdp.send("Page.stopScreencast");
    writeFileSync(join(this.dir, "timeline.json"), JSON.stringify({ frames: this.frames, end: Date.now() / 1000 }, null, 1));
  }
}
const rec = new Recorder();
await rec.init();

// ---- pointer and input helpers (a drawn cursor, since headless Chrome has none) ----
async function point(loc: Locator) {
  await loc.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
  await page.waitForTimeout(500);
  const b = (await loc.boundingBox())!;
  await page.evaluate(([x, y]) => {
    const c = document.getElementById("__cursor");
    if (c) c.style.transform = `translate(${x}px,${y}px)`;
  }, [b.x + Math.min(b.width / 2, 60), b.y + b.height / 2]);
  await page.waitForTimeout(800);
}
async function click(loc: Locator) {
  await point(loc);
  await loc.click();
}
async function typeInto(loc: Locator, text: string) {
  await click(loc);
  await loc.pressSequentially(text, { delay: 22 });
}
async function paste(loc: Locator, text: string) {
  await click(loc);
  await loc.fill(text);
}
async function show(loc: Locator, ms = 2500) {
  await point(loc);
  await page.waitForTimeout(ms);
}
async function tab(name: string) {
  await click(page.getByRole("tab", { name }));
  await page.waitForTimeout(1200);
}
async function connectAs(name: string) {
  who = keyAccount(name);
  await click(page.locator("header.top button"));
  await page.locator("header.top button", { hasText: `${who.address.slice(0, 6)}` }).waitFor({ timeout: 30_000 });
  log(`wallet: ${name} ${who.address}`);
}
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ---- terminal: real child processes, output streamed into an on-screen terminal ----
const TERMINAL = `<!doctype html><html><head><style>
  html,body{margin:0;height:100%;background:#0b0f14;font-family:Consolas,'Cascadia Mono',monospace}
  .bar{height:38px;background:#1f2937;color:#9ca3af;font:15px 'Segoe UI',sans-serif;display:flex;align-items:center;padding:0 18px;gap:8px}
  .dot{width:12px;height:12px;border-radius:50%;display:inline-block}
  #t{padding:18px 26px;color:#e5e7eb;font-size:16.5px;line-height:1.5;white-space:pre-wrap;word-break:break-all;height:calc(100% - 74px);overflow:hidden}
  .p{color:#34d399}.c{color:#f8fafc;font-weight:600}.ok{color:#34d399}.bad{color:#f87171}.warn{color:#fbbf24}.url{color:#22d3ee}.dim{color:#94a3b8}
</style></head><body><div class="bar"><span class="dot" style="background:#ef4444"></span><span class="dot" style="background:#f59e0b"></span><span class="dot" style="background:#10b981"></span>&nbsp; payeeguard/assistant · invoice assistant on QDay Aevum testnet</div><div id="t"></div>
<script>
  const t = document.getElementById('t');
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  function cls(line) {
    if (/decision: PAY|-> paid|^granted/.test(line)) return 'ok';
    if (/REFUSE|rejected|Not|refused|!!/.test(line)) return 'bad';
    if (/ASK_OWNER|warning|waiting for the owner/.test(line)) return 'warn';
    if (/^https?:/.test(line.trim())) return 'url';
    if (/^\\s+- /.test(line)) return 'dim';
    return '';
  }
  let buf = '';
  window.term = {
    clear() { t.innerHTML = ''; },
    async cmd(text) {
      const line = document.createElement('div');
      line.innerHTML = '<span class="p">$ </span><span class="c"></span>';
      t.appendChild(line);
      const c = line.lastChild;
      for (const ch of text) { c.textContent += ch; await new Promise((r) => setTimeout(r, 32)); }
    },
    out(chunk) {
      buf += chunk;
      const parts = buf.split('\\n');
      buf = parts.pop();
      for (const p of parts) {
        const d = document.createElement('div');
        d.className = cls(p);
        d.innerHTML = esc(p).replace(/(https?:\\/\\/\\S+)/g, '<span class="url">$1</span>') || '&nbsp;';
        t.appendChild(d);
      }
      while (t.scrollHeight > t.clientHeight && t.children.length > 1) t.removeChild(t.firstChild);
    },
  };
</script></body></html>`;

// setContent keeps the current origin's CSP (the explorer forbids inline scripts), so start from about:blank.
async function blank(html: string) {
  await page.goto("about:blank");
  await page.setContent(html);
}
async function terminal() {
  await blank(TERMINAL);
}
async function shell(display: string, args: string[]) {
  await page.evaluate((s) => (window as any).term.cmd(s), display);
  await page.waitForTimeout(500);
  let all = "";
  await new Promise<void>((resolve) => {
    const p = spawn("pnpm", ["--silent", ...args], { cwd: ASSISTANT, shell: true });
    const push = (d: Buffer) => {
      all += d.toString();
      page.evaluate((s) => (window as any).term.out(s), d.toString().replace(/\r/g, "")).catch(() => {});
    };
    p.stdout.on("data", push);
    p.stderr.on("data", push);
    p.on("close", () => resolve());
  });
  await page.evaluate(() => (window as any).term.out("\n"));
  await page.waitForTimeout(2200);
  log(`${display}\n${all.trim()}`);
  return all;
}
const txOf = (s: string) => s.match(/\/tx\/(0x[0-9a-fA-F]{64})/)?.[1];

// ---- slides ----
async function slide(id: string, html: string) {
  mkdirSync(join(OUT, "slides"), { recursive: true });
  await blank(`<!doctype html><html><head><style>
    html,body{margin:0;width:1280px;height:720px;background:#0f172a;color:#f8fafc;font-family:'Segoe UI',sans-serif}
    .s{position:relative;height:100%;padding:70px 90px;box-sizing:border-box}
    .s:before{content:'';position:absolute;left:0;top:0;bottom:0;width:10px;background:#14b8a6}
    .k{color:#2dd4bf;font-weight:700;letter-spacing:.12em;font-size:18px;text-transform:uppercase}
    h1{font-size:54px;margin:14px 0 18px;line-height:1.1} h2{font-size:40px;margin:10px 0 22px}
    p,li{font-size:25px;line-height:1.45;color:#e2e8f0} li{margin:6px 0} .m{color:#94a3b8} code{font-family:Consolas,monospace;color:#5eead4}
    .foot{position:absolute;left:90px;right:90px;bottom:40px;font-size:18px;color:#94a3b8;display:flex;justify-content:space-between}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px 40px} .box{border:2px solid #334155;border-radius:14px;padding:14px 18px;background:#111c33}
    .box b{display:block;font-size:22px;color:#5eead4;margin-bottom:4px} .box span{font-size:19px;color:#cbd5e1;line-height:1.35;display:block}
  </style></head><body>${html}</body></html>`);
  await page.screenshot({ path: join(OUT, "slides", `${id}.jpg`), type: "jpeg", quality: 95 });
}

// ---- invoices for this run (fresh ids; the web scenes and the assistant each need unpaid ones) ----
function makeInvoices(dir: string) {
  mkdirSync(dir, { recursive: true });
  return new Promise<void>((resolve, reject) => {
    const p = spawn("npx", ["tsx", "examples/make-invoices.ts", dir], { cwd: join(ROOT, "sdk"), shell: true, stdio: "inherit" });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`make-invoices exited ${code}`))));
  });
}

// =====================================================================================================
// Setup (not recorded): invoices and the assistant's examples
const WEBINV = join(OUT, "invoices", "web");
const AINV = join(OUT, "invoices", "assistant");
const LATER = join(OUT, "invoices", "later");
// SCENES=a,b,... re-records a subset (each scene leaves the chain in the state the next one expects).
const ALL = ["business-add", "fake-check", "business-cancel", "legit-pay", "explorer", "assistant-pay", "assistant-cap", "agent-revoke", "assistant-revoked"];
const SCENES = new Set(process.env.SCENES ? process.env.SCENES.split(",") : ALL);
const want = (id: string) => SCENES.has(id);
if (["business-add", "fake-check", "business-cancel", "legit-pay"].some(want)) {
  await makeInvoices(WEBINV);
  await page.waitForTimeout(6000);
}
if (want("assistant-pay")) {
  await makeInvoices(AINV);
  await page.waitForTimeout(6000);
  await makeInvoices(LATER);
  for (const f of ["legit.txt", "injection.txt", "big.txt", "fake.txt", "plain.txt"]) copyFileSync(join(AINV, f), join(ASSISTANT, "examples", f));
  copyFileSync(join(LATER, "legit.txt"), join(ASSISTANT, "examples", "legit-2.txt"));
}
const fakeEmail = readFileSync(join(WEBINV, "fake.txt"), "utf8");
const legitEmail = readFileSync(join(WEBINV, "legit.txt"), "utf8");

// Slides
await slide(
  "title",
  `<div class="s"><div class="k">Aevum Builder Challenge #1 · QDay Aevum testnet</div><h1 style="font-size:76px;margin-top:90px">PayeeGuard</h1>
   <p style="font-size:32px">Confirmation of payee for stablecoin invoices,<br>for people and for AI agents that pay them.</p>
   <p class="m" style="margin-top:60px">Emil Huseynov · ${SITE.replace("https://", "")}</p>
   <div class="foot"><span>All transactions in this video are real, on Aevum testnet (chain 44005), tUSD8 test tokens.</span><span>Narration: synthetic voice</span></div></div>`,
);
await slide(
  "problem",
  `<div class="s"><div class="k">The problem</div><h1>"Our bank details have changed."</h1>
   <ul><li>Invoice redirection is the costliest payment fraud for small businesses.</li>
   <li>Banks answer it with Confirmation of Payee. Stablecoin payments are instant and final, and have nothing like it.</li>
   <li>AI assistants that pay invoices can be talked into paying anyone.</li></ul>
   <p style="margin-top:34px;color:#5eead4">PayeeGuard: a new payout address is not payable until a cooling-off passes,<br>and agents pay through scoped session keys, enforced on chain.</p></div>`,
);
await slide(
  "built",
  `<div class="s"><div class="k">How it is built</div><h2>Five contracts on Aevum, one SDK, two front ends</h2>
   <div class="grid">
    <div class="box"><b>ERC-8004 IdentityRegistry</b><span>official contracts, deployed on Aevum; the business identity</span></div>
    <div class="box"><b>PayeeRegistry</b><span>payout addresses per identity, cooling-off, guardian, cancel and revoke</span></div>
    <div class="box"><b>InvoicePay</b><span>EIP-712 signed invoices, ERC-1271, permit, typed refusals, receipts</span></div>
    <div class="box"><b>PayeeGuardAccount (ERC-4337 v0.7)</b><span>session-key policy inside validateUserOp: target, caps, payees, expiry</span></div>
    <div class="box"><b>tUSD8 paymaster</b><span>gas paid in tUSD8; the agent account holds no tQDAY</span></div>
    <div class="box"><b>QDay's bundler</b><span>ERC-7562 safe mode; our own Alto as the fallback</span></div>
   </div>
   <p class="m" style="margin-top:22px;font-size:21px">88 Foundry tests · TypeScript SDK with tests · deployed bytecode matched to source · MIT licence</p></div>`,
);
await slide(
  "close",
  `<div class="s"><div class="k">Next</div><h2>A check before every stablecoin invoice payment</h2>
   <ul><li>Business model: a per-check fee for payers; the registry stays free for businesses.</li>
   <li>Distribution: the SDK in invoicing tools and agent frameworks.</li>
   <li>Roadmap: mainnet, an oracle-priced paymaster, a Kernel (ERC-7579) module, change alerts by email.</li></ul>
   <p style="margin-top:40px">Live: <code>${SITE.replace("https://", "")}</code></p>
   <p>Code: <code>github.com/emilhuseyn/aevum-qday</code></p>
   <div class="foot"><span>PayeeGuard · Emil Huseynov</span><span>Narration: synthetic voice</span></div></div>`,
);

// =====================================================================================================
// Scene: the business adds a payout address (playing the attacker with a stolen key)
const payoutCard = page.locator(".card", { hasText: "Payout addresses of agent #0" });
const verdict = page.locator(".card", { hasText: "Verdict" });
if (want("business-add")) {
await page.goto(`${SITE}/#business`);
await page.waitForLoadState("networkidle");
await rec.start("business-add");
await page.waitForTimeout(1000);
await connectAs("BUSINESS");
await payoutCard.waitFor({ timeout: 60_000 });
await show(payoutCard.locator("table"), 2500);
await typeInto(page.getByPlaceholder("New payout address 0x…"), attacker);
await click(page.getByRole("button", { name: /Add \(starts cooling-off\)/ }));
const coolingRow = payoutCard.locator("tr", { hasText: shortAddr(attacker) }).locator("text=cooling off");
await coolingRow.waitFor({ timeout: 90_000 });
await show(coolingRow, 4000);
await rec.stop();
}

// Scene: the fake "new bank details" invoice is checked
if (want("fake-check")) {
await tab("Check & pay");
await rec.start("fake-check");
await page.waitForTimeout(800);
await paste(page.getByLabel("Invoice text"), fakeEmail);
await verdict.locator("text=Do not pay").waitFor({ timeout: 60_000 });
await show(verdict.locator("text=Do not pay"), 3500);
await show(verdict.locator("dd", { hasText: "payable" }).first(), 3000);
const history = page.locator(".card", { hasText: "Payout address history" });
if (await history.count()) await show(history, 3500);
await rec.stop();
}

// Scene: the business cancels it inside the window; the invoice is refused for good
if (want("business-cancel")) {
await tab("Business");
await rec.start("business-cancel");
await payoutCard.waitFor({ timeout: 60_000 });
await click(payoutCard.locator("tr", { hasText: shortAddr(attacker) }).getByRole("button", { name: "Cancel" }));
await payoutCard.locator("tr", { hasText: shortAddr(attacker) }).locator("text=cancelled").waitFor({ timeout: 90_000 });
await show(payoutCard.locator("tr", { hasText: shortAddr(attacker) }), 2500);
await tab("Check & pay");
await paste(page.getByLabel("Invoice text"), fakeEmail);
await verdict.locator("text=Do not pay").waitFor({ timeout: 60_000 });
await show(verdict.locator("text=Do not pay"), 3500);
await rec.stop();
}

// Scene: a genuine invoice, paid by an EOA with one permit signature and one transaction
let payTx = "";
if (want("legit-pay")) {
if (!want("business-cancel")) {
  await page.goto(`${SITE}/#pay`);
  await page.waitForLoadState("networkidle");
}
await rec.start("legit-pay");
await paste(page.getByLabel("Invoice text"), legitEmail);
await verdict.locator("text=Safe to pay").waitFor({ timeout: 60_000 });
await show(verdict.locator("text=Safe to pay"), 2500);
const idCard = page.locator(".card", { hasText: "Business identity (ERC-8004)" });
await show(idCard, 2500);
await connectAs("PAYER_OWNER");
await click(verdict.getByRole("button", { name: /^Pay / }));
await verdict.locator("text=Paid: receipt on chain").waitFor({ timeout: 120_000 });
const txLink = verdict.getByRole("link", { name: /View transaction/ });
await show(txLink, 2500);
payTx = (await txLink.getAttribute("href"))!;
run.webPayTx = payTx;
await rec.stop();
}

// Scene: the receipt on QDay's explorer
if (want("explorer") && payTx) {
await rec.start("explorer");
await page.goto(payTx);
await page.waitForLoadState("networkidle").catch(() => {});
await page.waitForTimeout(6000);
await rec.stop();
}

// Scene: the assistant pays with its session key; then a prompt-injection email
if (want("assistant-pay")) {
await terminal();
await rec.start("assistant-pay");
await page.waitForTimeout(800);
const grantOut = await shell("pnpm grant", ["grant"]);
run.grantTx = txOf(grantOut);
const legitOut = await shell("pnpm pay examples/legit.txt", ["pay", "examples/legit.txt"]);
run.agentPayTx = txOf(legitOut);
const injOut = await shell("pnpm pay examples/injection.txt", ["pay", "examples/injection.txt"]);
run.injectionTx = txOf(injOut);
await rec.stop();
}
const session = JSON.parse(readFileSync(join(ASSISTANT, ".session.json"), "utf8")) as { address: string; account: string };
run.session = session.address;

// Scene: over the cap; then a compromised assistant that ignores its policy
if (want("assistant-cap")) {
await terminal();
await rec.start("assistant-cap");
await page.waitForTimeout(600);
await shell("pnpm pay examples/big.txt", ["pay", "examples/big.txt"]);
const forced = await shell("pnpm pay examples/big.txt --ignore-policy", ["pay", "examples/big.txt", "--ignore-policy"]);
run.forcedRejected = /rejected at validation/.test(forced);
await rec.stop();
}

// Scene: the owner reviews the agent account and revokes the session key (a gasless UserOperation)
if (want("agent-revoke")) {
await page.goto(`${SITE}/#agent`);
await page.waitForLoadState("networkidle");
await rec.start("agent-revoke");
await page.waitForTimeout(800);
await connectAs("PAYER_OWNER");
const balances = page.locator(".card", { hasText: "Balances" });
await balances.locator("text=needs none").waitFor({ timeout: 60_000 });
await show(balances, 3000);
const audit = page.locator(".card", { hasText: "Agent payments (audit trail)" });
await show(audit, 3000);
const sessionRow = page.locator(".card", { hasText: "Session keys" }).locator("tr", { hasText: shortAddr(session.address) });
await show(sessionRow, 2500);
await click(sessionRow.getByRole("button", { name: "Revoke" }));
const revoked = page.locator("text=Session revoked");
await revoked.waitFor({ timeout: 180_000 });
await show(revoked, 3000);
run.revokeTx = await page.locator(".card", { hasText: "Session revoked" }).locator('a[href*="/tx/"]').last().getAttribute("href");
await rec.stop();
}

// Scene: the revoked key is dead
if (want("assistant-revoked")) {
await terminal();
await rec.start("assistant-revoked");
await page.waitForTimeout(600);
const dead = await shell("pnpm pay examples/legit-2.txt --ignore-policy", ["pay", "examples/legit-2.txt", "--ignore-policy"]);
run.revokedRejected = /SessionNotActive/.test(dead);
await rec.stop();
}

run.finishedAt = new Date().toISOString();
writeFileSync(join(OUT, `run-${Date.now()}.json`), JSON.stringify(run, null, 2));
log(JSON.stringify(run, null, 2));
await browser.close();
