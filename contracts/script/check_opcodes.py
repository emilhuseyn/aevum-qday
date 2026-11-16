"""Fail if any contract we deploy contains an instruction Aevum (cdk-erigon, Shanghai level) rejects.

Usage (from contracts/):  py script/check_opcodes.py
Reads solc's optimized assembly (`forge inspect <C> assemblyOptimized`), which lists real instructions and keeps
constant data sections (`data_...`) apart; a raw byte walk flags constants after the code as fake opcodes.
"""

import re
import subprocess
import sys

FORBIDDEN = re.compile(r"^\s*(mcopy|tload|tstore|blobhash|blobbasefee)\b", re.IGNORECASE)
CONTRACTS = [
    "PayeeRegistry",
    "InvoicePay",
    "IdentityRegistryUpgradeable",
    "HardhatMinimalUUPS",
    # ERC-8004's ERC1967Proxy wrapper (OZ's 110-byte proxy) is not listed: its name is ambiguous for forge inspect.
]


def main() -> int:
    bad = 0
    for name in CONTRACTS:
        asm = subprocess.run(
            ["forge", "inspect", name, "assemblyOptimized"], capture_output=True, text=True, check=True
        ).stdout
        hits = [line.strip() for line in asm.splitlines() if FORBIDDEN.match(line)]
        print(f"{name:32s} {'OK' if not hits else 'FORBIDDEN: ' + ', '.join(sorted(set(hits)))}")
        bad += bool(hits)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
