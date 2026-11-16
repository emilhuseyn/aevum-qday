// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IdentityRegistryUpgradeable} from "erc8004/IdentityRegistryUpgradeable.sol";
import {HardhatMinimalUUPS} from "erc8004/HardhatMinimalUUPS.sol";
import {ERC1967Proxy} from "erc8004/ERC1967Proxy.sol";

/// @notice Deploys the official, unmodified ERC-8004 IdentityRegistry (erc-8004/erc-8004-contracts) behind a UUPS proxy,
/// the same two-step way the reference repo does locally: a bootstrap UUPS implementation owned by the caller, then
/// upgradeToAndCall into IdentityRegistryUpgradeable.initialize(). The canonical 0x8004... deployment is not on Aevum.
library IdentityDeployer {
    function deploy() internal returns (IdentityRegistryUpgradeable registry) {
        HardhatMinimalUUPS bootstrap = new HardhatMinimalUUPS();
        ERC1967Proxy proxy =
            new ERC1967Proxy(address(bootstrap), abi.encodeCall(HardhatMinimalUUPS.initialize, (address(0))));
        IdentityRegistryUpgradeable implementation = new IdentityRegistryUpgradeable();
        HardhatMinimalUUPS(address(proxy)).upgradeToAndCall(
            address(implementation), abi.encodeCall(IdentityRegistryUpgradeable.initialize, ())
        );
        registry = IdentityRegistryUpgradeable(address(proxy));
    }
}
