import type { Address, PublicClient } from "viem";
import { identityRegistryAbi } from "./abis.js";
import { payeeGuardAddresses } from "./chain.js";

export type AgentRegistration = {
  type?: string;
  name?: string;
  description?: string;
  image?: string;
  services?: { name: string; endpoint: string; version?: string }[];
  registrations?: { agentId: number | string; agentRegistry: string }[];
};

export type BusinessIdentity = {
  agentId: bigint;
  owner: Address;
  agentURI: string;
  agentRegistry: string;
  registration?: AgentRegistration;
  /** The registration file lists this exact on-chain agent (ERC-8004 "registrations" entry). */
  registrationMatches: boolean;
  /** https domain that served the registration file, when it did. */
  domain?: string;
  error?: string;
};

function resolveUri(uri: string): string {
  if (uri.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${uri.slice(7)}`;
  return uri;
}

/** Reads an ERC-8004 identity and its registration file (name, services) and checks the file names this agent. */
export async function getBusinessIdentity(client: PublicClient, agentId: bigint): Promise<BusinessIdentity> {
  const chainId = client.chain?.id ?? 44005;
  const { identityRegistry } = payeeGuardAddresses(chainId);
  const agentRegistry = `eip155:${chainId}:${identityRegistry}`;
  const [owner, agentURI] = await Promise.all([
    client.readContract({ address: identityRegistry, abi: identityRegistryAbi, functionName: "ownerOf", args: [agentId] }),
    client.readContract({ address: identityRegistry, abi: identityRegistryAbi, functionName: "tokenURI", args: [agentId] }),
  ]);
  const out: BusinessIdentity = { agentId, owner, agentURI, agentRegistry, registrationMatches: false };
  try {
    let registration: AgentRegistration;
    if (agentURI.startsWith("data:")) {
      const [, payload] = agentURI.split(",", 2);
      registration = JSON.parse(agentURI.includes(";base64") ? atob(payload) : decodeURIComponent(payload));
    } else {
      const url = resolveUri(agentURI);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`registration file: HTTP ${res.status}`);
      registration = await res.json();
      if (url.startsWith("https://")) out.domain = new URL(url).hostname;
    }
    out.registration = registration;
    out.registrationMatches = (registration.registrations ?? []).some(
      (r) => String(r.agentId) === agentId.toString() && r.agentRegistry.toLowerCase() === agentRegistry.toLowerCase(),
    );
  } catch (e) {
    out.error = (e as Error).message;
  }
  return out;
}
