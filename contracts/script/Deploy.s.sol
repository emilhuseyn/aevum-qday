// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IdentityRegistryUpgradeable} from "erc8004/IdentityRegistryUpgradeable.sol";
import {IdentityDeployer} from "./IdentityDeployer.sol";
import {PayeeRegistry} from "../src/PayeeRegistry.sol";
import {InvoicePay} from "../src/InvoicePay.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";

/// @notice Deploys ERC-8004 IdentityRegistry (official contracts), PayeeRegistry and InvoicePay, and records the
/// addresses in deployments/<chainId>.json.
/// Env: DEPLOYER_KEY (required); MIN_COOLING_OFF and DEFAULT_COOLING_OFF in seconds (demo default 60 / 120).
contract Deploy is Script {
    bytes32 constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    function run() external {
        uint256 key = vm.envUint("DEPLOYER_KEY");
        uint32 minCoolingOff = uint32(vm.envOr("MIN_COOLING_OFF", uint256(60)));
        uint32 defaultCoolingOff = uint32(vm.envOr("DEFAULT_COOLING_OFF", uint256(120)));

        vm.startBroadcast(key);
        IdentityRegistryUpgradeable identity = IdentityDeployer.deploy();
        PayeeRegistry registry =
            new PayeeRegistry(IIdentityRegistry(address(identity)), minCoolingOff, defaultCoolingOff);
        InvoicePay invoicePay = new InvoicePay(registry);
        vm.stopBroadcast();

        address identityImpl = address(uint160(uint256(vm.load(address(identity), IMPLEMENTATION_SLOT))));
        require(keccak256(bytes(identity.getVersion())) == keccak256("2.0.0"), "identity not upgraded");

        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "deployer", vm.addr(key));
        vm.serializeAddress(obj, "identityRegistry", address(identity));
        vm.serializeAddress(obj, "identityRegistryImplementation", identityImpl);
        vm.serializeAddress(obj, "payeeRegistry", address(registry));
        vm.serializeAddress(obj, "invoicePay", address(invoicePay));
        vm.serializeUint(obj, "minCoolingOff", minCoolingOff);
        string memory json = vm.serializeUint(obj, "defaultCoolingOff", defaultCoolingOff);
        vm.writeJson(json, string.concat("./deployments/", vm.toString(block.chainid), ".json"));

        console2.log("IdentityRegistry (ERC-8004 proxy)", address(identity));
        console2.log("IdentityRegistry implementation  ", identityImpl);
        console2.log("PayeeRegistry                    ", address(registry));
        console2.log("InvoicePay                       ", address(invoicePay));
    }
}
