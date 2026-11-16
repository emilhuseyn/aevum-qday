// JSON-RPC shim for the Aevum testnet RPC (cdk-erigon).
//
// cdk-erigon parses eth_call / eth_estimateGas / debug_traceCall state-override storage values ("state" and
// "stateDiff") as uint256 quantities and rejects the 32-byte padded form that geth, ERC-4337 bundlers (Alto) and
// viem send: "invalid argument 2: hex number with leading zero digits". This shim rewrites those values to minimal
// quantities ("0x00..07" -> "0x7") and forwards everything else unchanged, including batches.
//
//   node aevum-rpc-shim.mjs            listens on 127.0.0.1:8546, upstream https://rpc-test.qday.info
//   SHIM_PORT=8546 UPSTREAM_RPC=... node aevum-rpc-shim.mjs
import { createServer } from "node:http";

const UPSTREAM = process.env.UPSTREAM_RPC ?? "https://rpc-test.qday.info";
const PORT = Number(process.env.SHIM_PORT ?? 8546);
const HOST = process.env.SHIM_HOST ?? "127.0.0.1";
const OVERRIDE_PARAM = { eth_call: 2, eth_estimateGas: 2, debug_traceCall: 2 };

export function toQuantity(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) return value;
  return "0x" + BigInt(value === "0x" ? "0x0" : value).toString(16);
}

export function normalizeOverrides(overrides) {
  if (!overrides || typeof overrides !== "object") return overrides;
  let changed = 0;
  for (const account of Object.values(overrides)) {
    for (const field of ["state", "stateDiff"]) {
      const slots = account?.[field];
      if (!slots || typeof slots !== "object") continue;
      for (const [slot, value] of Object.entries(slots)) {
        const q = toQuantity(value);
        if (q !== value) {
          slots[slot] = q;
          changed++;
        }
      }
    }
  }
  return changed;
}

export function rewrite(request) {
  if (Array.isArray(request)) return request.reduce((n, r) => n + rewrite(r), 0);
  const index = OVERRIDE_PARAM[request?.method];
  if (index === undefined) return 0;
  // debug_traceCall carries overrides inside its config object (param 2).
  const param = request.params?.[index];
  if (request.method === "debug_traceCall") return normalizeOverrides(param?.stateOverrides);
  return normalizeOverrides(param);
}

const server = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(200, { "content-type": "text/plain" }).end("aevum-rpc-shim: POST JSON-RPC here\n");
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = JSON.parse(body);
    if (rewrite(parsed) > 0) body = JSON.stringify(parsed);
  } catch {
    // not JSON: forward as is and let upstream answer
  }
  try {
    const upstream = await fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body });
    const text = await upstream.text();
    res.writeHead(upstream.status, { "content-type": "application/json" }).end(text);
  } catch (e) {
    res.writeHead(502, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: `shim upstream error: ${e.message}` } }));
  }
});

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("aevum-rpc-shim.mjs")) {
  server.listen(PORT, HOST, () => console.log(`aevum-rpc-shim on http://${HOST}:${PORT} -> ${UPSTREAM}`));
}
