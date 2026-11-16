// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IdentityRegistryUpgradeable} from "erc8004/IdentityRegistryUpgradeable.sol";
import {PayeeRegistry} from "../src/PayeeRegistry.sol";
import {InvoicePay, Invoice} from "../src/InvoicePay.sol";

/// @notice Lead 1 on Aevum testnet with real tUSD8, in two phases (the demo deployment's cooling-off is 120 s):
///   forge script script/DemoFlow.s.sol --sig "setup()" ...   business identity + payout address; funds the payer
///   forge script script/DemoFlow.s.sol --sig "pay()" ...     legit invoice paid; a correctly signed "new bank
///                                                            details" invoice is refused (cooling-off) and cancelled
/// Env: DEPLOYER_KEY, BUSINESS_KEY, PAYER_OWNER_KEY, ATTACKER_ADDR (from the git-ignored .env).
contract DemoFlow is Script {
    IERC20 constant TUSD8 = IERC20(0x456569838f1d43009A91ebA4263147Afd7233483);
    uint256 constant INVOICE_AMOUNT = 250_000; // 0.25 tUSD8 (6 decimals)
    string constant AGENT_URI = "https://github.com/emilhuseyn/aevum-qday/blob/main/demo/forela-agent.json";

    function _deployment() internal view returns (IdentityRegistryUpgradeable, PayeeRegistry, InvoicePay) {
        string memory json = vm.readFile(string.concat("./deployments/", vm.toString(block.chainid), ".json"));
        return (
            IdentityRegistryUpgradeable(vm.parseJsonAddress(json, ".identityRegistry")),
            PayeeRegistry(vm.parseJsonAddress(json, ".payeeRegistry")),
            InvoicePay(vm.parseJsonAddress(json, ".invoicePay"))
        );
    }

    function _demoFile() internal view returns (string memory) {
        return string.concat("./deployments/demo-", vm.toString(block.chainid), ".json");
    }

    function setup() external {
        (IdentityRegistryUpgradeable identity, PayeeRegistry registry,) = _deployment();
        uint256 businessKey = vm.envUint("BUSINESS_KEY");
        address business = vm.addr(businessKey);
        address payer = vm.addr(vm.envUint("PAYER_OWNER_KEY"));

        vm.startBroadcast(vm.envUint("DEPLOYER_KEY"));
        if (business.balance < 0.02 ether) payable(business).transfer(0.05 ether);
        if (payer.balance < 0.02 ether) payable(payer).transfer(0.05 ether);
        if (TUSD8.balanceOf(payer) < INVOICE_AMOUNT) TUSD8.transfer(payer, 2 * INVOICE_AMOUNT);
        vm.stopBroadcast();

        vm.startBroadcast(businessKey);
        uint256 agentId = identity.register(AGENT_URI);
        uint64 activeAt = registry.requestPayee(agentId, business);
        vm.stopBroadcast();

        string memory obj = "demo";
        vm.serializeUint(obj, "agentId", agentId);
        vm.serializeAddress(obj, "business", business);
        vm.serializeAddress(obj, "payout", business);
        string memory json = vm.serializeUint(obj, "payoutActiveAt", activeAt);
        vm.writeJson(json, _demoFile());
        console2.log("Forela agentId", agentId);
        console2.log("payout address active at (unix)", activeAt);
    }

    function _invoice(uint256 agentId, bytes32 id, address payTo, address payer, address token)
        internal
        view
        returns (Invoice memory)
    {
        return Invoice({
            invoiceId: id,
            payeeAgentId: agentId,
            payTo: payTo,
            token: token,
            amount: INVOICE_AMOUNT,
            payer: payer,
            issuedAt: uint64(block.timestamp),
            dueBy: uint64(block.timestamp + 7 days),
            detailsHash: keccak256(abi.encodePacked("Forela Ltd ", id, ": security review, 0.25 tUSD8"))
        });
    }

    function _sign(InvoicePay pay, Invoice memory inv, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, pay.hashInvoice(inv));
        return abi.encodePacked(r, s, v);
    }

    function pay() external {
        uint256 agentId = vm.parseJsonUint(vm.readFile(_demoFile()), ".agentId");
        bytes32 invoiceId = _payLegit(agentId);
        _newBankDetails(agentId, invoiceId);
    }

    /// 1. The real invoice: green verdict, paid, receipt on chain.
    function _payLegit(uint256 agentId) internal returns (bytes32 invoiceId) {
        (,, InvoicePay invoicePay) = _deployment();
        uint256 businessKey = vm.envUint("BUSINESS_KEY");
        uint256 payerKey = vm.envUint("PAYER_OWNER_KEY");
        address payer = vm.addr(payerKey);

        invoiceId = keccak256(abi.encodePacked("FORELA-INV-", vm.toString(block.timestamp)));
        Invoice memory inv = _invoice(agentId, invoiceId, vm.addr(businessKey), payer, address(TUSD8));
        bytes memory sig = _sign(invoicePay, inv, businessKey);
        (InvoicePay.Verdict verdict,) = invoicePay.checkInvoice(inv, sig, payer);
        require(verdict == InvoicePay.Verdict.Payable, "legit invoice not payable yet (cooling-off 120 s?)");
        vm.startBroadcast(payerKey);
        TUSD8.approve(address(invoicePay), INVOICE_AMOUNT);
        invoicePay.payInvoice(inv, sig);
        vm.stopBroadcast();
        console2.log("paid legit invoice, key:");
        console2.logBytes32(invoicePay.invoiceKey(agentId, invoiceId));
    }

    /// 2. "Our bank details have changed": the attacker holds the business key, adds a payout address and signs a
    ///    perfectly valid invoice to it. InvoicePay refuses it during the cooling-off; the business cancels.
    function _newBankDetails(uint256 agentId, bytes32 invoiceId) internal {
        (, PayeeRegistry registry, InvoicePay invoicePay) = _deployment();
        uint256 businessKey = vm.envUint("BUSINESS_KEY");
        address payer = vm.addr(vm.envUint("PAYER_OWNER_KEY"));
        address attacker = vm.envAddress("ATTACKER_ADDR");

        vm.startBroadcast(businessKey);
        uint64 activeAt = registry.requestPayee(agentId, attacker);
        vm.stopBroadcast();
        Invoice memory fake = _invoice(agentId, keccak256(abi.encodePacked(invoiceId, "-NEW-BANK")), attacker, payer, address(TUSD8));
        bytes memory fakeSig = _sign(invoicePay, fake, businessKey);
        (InvoicePay.Verdict fakeVerdict, uint64 at) = invoicePay.checkInvoice(fake, fakeSig, payer);
        require(fakeVerdict == InvoicePay.Verdict.PayeeInCoolingOff && at == activeAt, "expected PayeeInCoolingOff");
        console2.log("new-bank-details invoice verdict: PayeeInCoolingOff until", at);

        vm.startBroadcast(businessKey);
        registry.cancelPayee(agentId, attacker);
        vm.stopBroadcast();
        (fakeVerdict,) = invoicePay.checkInvoice(fake, fakeSig, payer);
        require(fakeVerdict == InvoicePay.Verdict.PayeeNotRegistered, "expected PayeeNotRegistered after cancel");
        console2.log("business cancelled the change; verdict now PayeeNotRegistered");
    }
}
