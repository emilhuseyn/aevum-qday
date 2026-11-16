import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  hashMessage,
  hashTypedData,
  keccak256,
  numberToHex,
  type Address,
  type Call,
  type Chain,
  type Client,
  type Hex,
  type JsonRpcAccount,
  type LocalAccount,
  type Transport,
} from "viem";
import { entryPoint07Abi, getUserOperationHash, toSmartAccount, type SmartAccount } from "viem/account-abstraction";
import { getBlock, readContract } from "viem/actions";
import { payeeGuardAccountAbi, payeeGuardAccountFactoryAbi } from "./abis.js";
import { payeeGuardAddresses } from "./chain.js";
import type { Invoice } from "./invoice.js";

/** A 65-byte signature that parses but never recovers to a real key: used only for gas estimation. */
/** r = 0xff..f0 00..00, s = 0x7aa..a (below n/2, so OZ ECDSA parses it), v = 28. Exactly 65 bytes. */
export const DUMMY_ECDSA: Hex = `0x${"f".repeat(31)}0${"0".repeat(32)}7${"a".repeat(63)}1c`;
const SESSION_PREFIX: Hex = "0x01";
const DAY = 86_400n;

export type SessionPolicy = {
  token: Address;
  perPaymentCap: bigint;
  dailyCap: bigint;
  validAfter: number;
  validUntil: number;
  restrictPayees: boolean;
};

type AnyClient = Client<Transport, Chain | undefined, JsonRpcAccount | LocalAccount | undefined>;

export type ToPayeeGuardAccountParameters = {
  client: AnyClient;
  /** Owner address (for the counterfactual address) or the owner's signer (to sign as owner). */
  owner: Address | LocalAccount;
  /** Sign UserOperations as this session key instead of the owner. The session can only pay invoices. */
  session?: LocalAccount;
  salt?: bigint;
  address?: Address;
  factory?: Address;
  /** Override the UTC day index a session signs for (default: from the latest block's timestamp). */
  day?: number;
  /** EntryPoint nonce key (default 0). */
  nonceKey?: bigint;
};

export type PayeeGuardSmartAccount = SmartAccount & {
  owner: Address;
  sessionKey?: Address;
};

/** The UTC day index that a session signature names (unix seconds / 86400). */
export async function currentDay(client: AnyClient): Promise<number> {
  const block = await getBlock(client);
  return Number(block.timestamp / DAY);
}

/** What a session key signs: EIP-191 over keccak256(abi.encode(userOpHash, day)). Mirrors sessionDigest() on chain. */
export function sessionMessage(userOpHash: Hex, day: number): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint32" }], [userOpHash, day]));
}

export function encodeSessionSignature(sessionKey: Address, day: number, ecdsa: Hex): Hex {
  return concat([SESSION_PREFIX, sessionKey, numberToHex(day, { size: 4 }), ecdsa]);
}

/**
 * viem SmartAccount for PayeeGuardAccount (ERC-4337 v0.7). Works with any bundler client:
 *   const account = await toPayeeGuardAccount({ client, owner: ownerSigner });
 *   const account = await toPayeeGuardAccount({ client, owner: ownerAddress, session: agentSigner });
 */
export async function toPayeeGuardAccount(params: ToPayeeGuardAccountParameters): Promise<PayeeGuardSmartAccount> {
  const { client, session } = params;
  const chainId = client.chain?.id;
  const addresses = payeeGuardAddresses(chainId);
  const factory = params.factory ?? addresses.accountFactory;
  const salt = params.salt ?? 0n;
  const ownerSigner = typeof params.owner === "string" ? undefined : params.owner;
  const ownerAddress = typeof params.owner === "string" ? params.owner : params.owner.address;

  const address =
    params.address ??
    (await readContract(client, {
      address: factory,
      abi: payeeGuardAccountFactoryAbi,
      functionName: "getAddress",
      args: [ownerAddress, salt],
    }));

  let signingDay: number | undefined = params.day;
  const day = async () => signingDay ?? currentDay(client);

  const account = await toSmartAccount({
    client,
    entryPoint: { abi: entryPoint07Abi, address: addresses.entryPoint, version: "0.7" },

    async getAddress() {
      return address;
    },

    // Fixed nonce key (0 unless params.nonceKey). viem otherwise passes a time-based key (Date.now()), which QDay's
    // rundler rejects as "data did not match any variant of untagged enum RpcUserOperationOptionalGas".
    async getNonce() {
      return readContract(client, {
        address: addresses.entryPoint,
        abi: entryPoint07Abi,
        functionName: "getNonce",
        args: [address, params.nonceKey ?? 0n],
      });
    },

    async getFactoryArgs() {
      return {
        factory,
        factoryData: encodeFunctionData({
          abi: payeeGuardAccountFactoryAbi,
          functionName: "createAccount",
          args: [ownerAddress, salt],
        }),
      };
    },

    async encodeCalls(calls: readonly Call[]) {
      const self = (c: Call) => c.to.toLowerCase() === address.toLowerCase() && !c.value;
      if (session) {
        if (calls.length !== 1 || !self(calls[0]) || !calls[0].data) {
          throw new Error("A session key can only send one payInvoice call to its own account (see payInvoiceCall).");
        }
        return calls[0].data;
      }
      if (calls.length === 1 && self(calls[0]) && calls[0].data) return calls[0].data;
      if (calls.length === 1) {
        return encodeFunctionData({
          abi: payeeGuardAccountAbi,
          functionName: "execute",
          args: [calls[0].to, calls[0].value ?? 0n, calls[0].data ?? "0x"],
        });
      }
      return encodeFunctionData({
        abi: payeeGuardAccountAbi,
        functionName: "executeBatch",
        args: [calls.map((c) => ({ target: c.to, value: c.value ?? 0n, data: c.data ?? "0x" }))],
      });
    },

    async getStubSignature() {
      if (!session) return DUMMY_ECDSA;
      return encodeSessionSignature(session.address, await day(), DUMMY_ECDSA);
    },

    async signUserOperation(userOperation) {
      const hash = getUserOperationHash({
        chainId: userOperation.chainId ?? chainId!,
        entryPointAddress: addresses.entryPoint,
        entryPointVersion: "0.7",
        userOperation: { ...userOperation, sender: userOperation.sender ?? address },
      });
      if (session) {
        const d = await day();
        const ecdsa = await session.signMessage({ message: { raw: sessionMessage(hash, d) } });
        return encodeSessionSignature(session.address, d, ecdsa);
      }
      if (!ownerSigner) throw new Error("Pass the owner's signer (not just its address) to sign as owner.");
      return ownerSigner.signMessage({ message: { raw: hash } });
    },

    // ERC-1271: the account accepts the owner's raw signature over the hash.
    async signMessage({ message }) {
      if (!ownerSigner?.sign) throw new Error("ERC-1271 signing needs the owner's local signer.");
      return ownerSigner.sign({ hash: hashMessage(message) });
    },

    async signTypedData(typedData) {
      if (!ownerSigner?.sign) throw new Error("ERC-1271 signing needs the owner's local signer.");
      return ownerSigner.sign({ hash: hashTypedData(typedData as never) });
    },
  });

  return Object.assign(account, { owner: ownerAddress, sessionKey: session?.address }) as PayeeGuardSmartAccount;
}

/** The call a session (or the owner) sends to pay a signed invoice from the account. */
export function payInvoiceCall(
  account: { address: Address },
  invoice: Invoice,
  invoiceSignature: Hex,
  sessionKey: Address = "0x0000000000000000000000000000000000000000",
): Call {
  return {
    to: account.address,
    data: encodeFunctionData({
      abi: payeeGuardAccountAbi,
      functionName: "payInvoice",
      args: [invoice, invoiceSignature, sessionKey],
    }),
  };
}

export function grantSessionCall(
  account: { address: Address },
  sessionKey: Address,
  policy: SessionPolicy,
  payeeAgentIds: bigint[] = [],
): Call {
  return {
    to: account.address,
    data: encodeFunctionData({
      abi: payeeGuardAccountAbi,
      functionName: "grantSession",
      args: [sessionKey, policy, payeeAgentIds],
    }),
  };
}

export function revokeSessionCall(account: { address: Address }, sessionKey: Address): Call {
  return {
    to: account.address,
    data: encodeFunctionData({ abi: payeeGuardAccountAbi, functionName: "revokeSession", args: [sessionKey] }),
  };
}
