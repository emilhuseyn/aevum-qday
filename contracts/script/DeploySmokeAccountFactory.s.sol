// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {SimpleAccountFactory} from "account-abstraction/samples/SimpleAccountFactory.sol";

/// @notice Bundler smoke test only: the eth-infinitism v0.7 sample SimpleAccountFactory, used to check that a bundler
/// accepts and lands a UserOperation on Aevum before PayeeGuard's own account exists. Not part of the product.
contract DeploySmokeAccountFactory is Script {
    address constant ENTRY_POINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    function run() external {
        vm.startBroadcast(vm.envUint("DEPLOYER_KEY"));
        SimpleAccountFactory factory = new SimpleAccountFactory(IEntryPoint(ENTRY_POINT_V07));
        vm.stopBroadcast();
        console2.log("SimpleAccountFactory (smoke test)", address(factory));
    }
}
