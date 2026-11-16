// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PayeeGuardAccountFactory} from "../src/PayeeGuardAccountFactory.sol";
import {InvoicePay} from "../src/InvoicePay.sol";

/// @notice Deploys PayeeGuardAccountFactory (and its account implementation) against the live EntryPoint v0.7 and the
/// InvoicePay recorded in deployments/<chainId>.json, and adds both addresses to that file.
contract DeployAccountFactory is Script {
    address constant ENTRY_POINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    function run() external {
        string memory path = string.concat("./deployments/", vm.toString(block.chainid), ".json");
        InvoicePay invoicePay = InvoicePay(vm.parseJsonAddress(vm.readFile(path), ".invoicePay"));

        vm.startBroadcast(vm.envUint("DEPLOYER_KEY"));
        PayeeGuardAccountFactory factory = new PayeeGuardAccountFactory(IEntryPoint(ENTRY_POINT_V07), invoicePay);
        vm.stopBroadcast();

        vm.writeJson(vm.toString(address(factory)), path, ".accountFactory");
        vm.writeJson(vm.toString(address(factory.accountImplementation())), path, ".accountImplementation");
        vm.writeJson(vm.toString(ENTRY_POINT_V07), path, ".entryPoint");
        console2.log("PayeeGuardAccountFactory", address(factory));
        console2.log("PayeeGuardAccount implementation", address(factory.accountImplementation()));
    }
}
