// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PayeeGuardPaymaster} from "../src/PayeeGuardPaymaster.sol";

/// @notice Deploys the tUSD8 gas paymaster, funds its EntryPoint deposit and stakes it (QDay's rundler requires a
/// staked paymaster for storage access and postOp context: >= 0.1 tQDAY, unstake delay >= 1 day).
/// Env: DEPLOYER_KEY; PAYMASTER_DEPOSIT / PAYMASTER_STAKE in wei (defaults 0.3 / 0.1 tQDAY).
contract DeployPaymaster is Script {
    address constant ENTRY_POINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;

    function run() external {
        string memory path = string.concat("./deployments/", vm.toString(block.chainid), ".json");
        uint256 depositWei = vm.envOr("PAYMASTER_DEPOSIT", uint256(0.3 ether));
        uint256 stakeWei = vm.envOr("PAYMASTER_STAKE", uint256(0.1 ether));

        vm.startBroadcast(vm.envUint("DEPLOYER_KEY"));
        // 1 tUSD8 per tQDAY of gas at cost, +5 % markup (testnet rate; tQDAY has no market price).
        PayeeGuardPaymaster paymaster =
            new PayeeGuardPaymaster(IEntryPoint(ENTRY_POINT_V07), IERC20(TUSD8), 1_000_000, 10_500);
        paymaster.deposit{value: depositWei}();
        paymaster.addStake{value: stakeWei}(1 days);
        vm.stopBroadcast();

        vm.writeJson(vm.toString(address(paymaster)), path, ".paymaster");
        console2.log("PayeeGuardPaymaster", address(paymaster));
        console2.log("deposit (wei)", paymaster.getDeposit());
    }
}
