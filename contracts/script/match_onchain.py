"""Prove the deployed contracts are exactly this source: compare local runtime bytecode with eth_getCode.

Usage (from contracts/, after `forge build`):  py script/match_onchain.py [deployments/44005.json]
Immutable values (set at deploy time) are masked on both sides using the compiler's immutableReferences; the
metadata hash at the end of the bytecode is compared as is, so any source or setting change shows up.
Why: the Aevum explorer's Blockscout verifier lists no compiler versions and has never verified a contract
(api/v2/smart-contracts/counters: verified_smart_contracts = 0, checked 16 Nov 2026), so this is the check
anyone can rerun until explorer verification works.
"""

import json
import pathlib
import sys
import urllib.request

RPC = "https://rpc-test.qday.info"
ROOT = pathlib.Path(__file__).resolve().parent.parent
TARGETS = {
    "identityRegistry": "ERC1967Proxy.sol/ERC1967Proxy.json",
    "identityRegistryImplementation": "IdentityRegistryUpgradeable.sol/IdentityRegistryUpgradeable.json",
    "payeeRegistry": "PayeeRegistry.sol/PayeeRegistry.json",
    "invoicePay": "InvoicePay.sol/InvoicePay.json",
}


def get_code(address: str) -> bytes:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_getCode", "params": [address, "latest"]}).encode()
    req = urllib.request.Request(RPC, body, {"content-type": "application/json", "user-agent": "payeeguard-check"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return bytes.fromhex(json.load(r)["result"].removeprefix("0x"))


def mask(code: bytearray, refs: dict) -> bytearray:
    for ranges in refs.values():
        for ref in ranges:
            code[ref["start"] : ref["start"] + ref["length"]] = bytes(ref["length"])
    return code


def main() -> int:
    deployment = json.loads((ROOT / (sys.argv[1] if len(sys.argv) > 1 else "deployments/44005.json")).read_text())
    failures = 0
    for key, artifact_path in TARGETS.items():
        art = json.loads((ROOT / "out" / artifact_path).read_text(encoding="utf-8"))
        local = bytearray(bytes.fromhex(art["deployedBytecode"]["object"].removeprefix("0x")))
        refs = art["deployedBytecode"].get("immutableReferences", {})
        onchain = bytearray(get_code(deployment[key]))
        same = len(local) == len(onchain) and mask(local, refs) == mask(onchain, refs)
        print(f"{key:32s} {deployment[key]}  {len(onchain):6d} bytes  {'MATCH' if same else 'DIFFERENT'}")
        failures += not same
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
