// Starts our own Alto bundler (ERC-4337 v0.7) against the Aevum testnet RPC.
// Keys come from the repo's git-ignored .env (BUNDLER_KEY) and reach Alto as ALTO_* environment variables,
// never as command-line arguments.
//
// Aevum specifics (see NOTES.md): cdk-erigon rejects feeless debug_traceCall and caps eth_getLogs at 1000 blocks,
// so Alto runs with --safe-mode false (no ERC-7562 tracer) and --max-block-range 999. cdk-erigon also rejects the
// 32-byte padded state-override values Alto sends during simulation, so Alto talks to the RPC through
// tools/rpc-shim (start it first: node tools/rpc-shim/aevum-rpc-shim.mjs). QDay's own bundler
// (https://bundler.qday.info, rundler) runs in safe mode; PayeeGuard's contracts are written to pass it.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
process.loadEnvFile(join(here, "..", "..", ".env"));

const key = process.env.BUNDLER_KEY?.trim();
if (!key) throw new Error("BUNDLER_KEY missing in .env");

const env = {
  ...process.env,
  ALTO_EXECUTOR_PRIVATE_KEYS: key,
  ALTO_UTILITY_PRIVATE_KEY: key,
};

const args = [
  join(here, "node_modules", "@pimlico", "alto", "esm", "cli", "alto.js"),
  "--entrypoints", "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  "--rpc-url", process.env.ALTO_UPSTREAM_RPC ?? "http://127.0.0.1:8546",
  "--port", process.env.ALTO_PORT ?? "4337",
  "--safe-mode", "false",
  "--max-block-range", "999",
  "--refilling-wallets", "false",
  "--log-level", process.env.ALTO_LOG_LEVEL ?? "info",
];

const child = spawn(process.execPath, args, { env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
