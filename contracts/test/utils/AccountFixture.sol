// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IdentityRegistryUpgradeable} from "erc8004/IdentityRegistryUpgradeable.sol";
import {IdentityDeployer} from "../../script/IdentityDeployer.sol";
import {PayeeRegistry} from "../../src/PayeeRegistry.sol";
import {InvoicePay, Invoice} from "../../src/InvoicePay.sol";
import {PayeeGuardAccount} from "../../src/PayeeGuardAccount.sol";
import {PayeeGuardAccountFactory} from "../../src/PayeeGuardAccountFactory.sol";
import {IIdentityRegistry} from "../../src/interfaces/IIdentityRegistry.sol";
import {MockUSD8} from "../mocks/MockUSD8.sol";

/// @notice Shared setup: EntryPoint v0.7, ERC-8004 identity, PayeeRegistry, InvoicePay, a PayeeGuardAccount with an
/// agent session (0.50 per payment, 0.80 per day, payee allowlist = Forela).
abstract contract AccountFixture is Test {
    uint128 constant PER_PAYMENT = 500_000; // 0.50 tUSD8
    uint128 constant DAILY = 800_000; // 0.80 tUSD8
    uint256 constant AMOUNT = 250_000;

    EntryPoint entryPoint;
    IdentityRegistryUpgradeable identity;
    PayeeRegistry registry;
    InvoicePay pay;
    MockUSD8 usd8;
    PayeeGuardAccountFactory factory;
    PayeeGuardAccount account;

    address owner;
    uint256 ownerKey;
    address agent;
    uint256 agentKey;
    address business;
    uint256 businessKey;
    address treasury = makeAddr("treasury");
    address payable bundler = payable(makeAddr("bundler"));
    uint256 agentId;
    uint256 otherAgentId;
    uint256 invoiceCounter;

    function setUp() public virtual {
        vm.warp(1_794_816_000 + 3 hours); // 2026-11-16 03:00 UTC
        (owner, ownerKey) = makeAddrAndKey("payerOwner");
        (agent, agentKey) = makeAddrAndKey("agentSession");
        (business, businessKey) = makeAddrAndKey("business");

        entryPoint = new EntryPoint();
        identity = IdentityDeployer.deploy();
        registry = new PayeeRegistry(IIdentityRegistry(address(identity)), 60, 120);
        pay = new InvoicePay(registry);
        usd8 = new MockUSD8();
        factory = new PayeeGuardAccountFactory(IEntryPoint(address(entryPoint)), pay);
        account = factory.createAccount(owner, 0);

        vm.startPrank(business);
        agentId = identity.register("https://forela.example/agent.json");
        otherAgentId = identity.register("https://other.example/agent.json");
        registry.requestPayee(agentId, treasury);
        registry.requestPayee(otherAgentId, treasury);
        vm.stopPrank();
        vm.warp(block.timestamp + 120);

        vm.deal(address(account), 1 ether);
        usd8.mint(address(account), 10_000_000);

        uint256[] memory allowed = new uint256[](1);
        allowed[0] = agentId;
        vm.prank(owner);
        account.grantSession(agent, _policy(), allowed);
    }

    // ------------------------------------------------------------------ helpers

    function _policy() internal view returns (PayeeGuardAccount.SessionPolicy memory) {
        return PayeeGuardAccount.SessionPolicy({
            token: address(usd8),
            perPaymentCap: PER_PAYMENT,
            dailyCap: DAILY,
            validAfter: uint48(block.timestamp),
            validUntil: uint48(block.timestamp + 7 days),
            restrictPayees: true
        });
    }

    function _today() internal view returns (uint32) {
        return uint32(block.timestamp / 1 days);
    }

    function _invoice(uint256 payee, uint256 amount) internal returns (Invoice memory inv, bytes memory sig) {
        inv = Invoice({
            invoiceId: bytes32(++invoiceCounter),
            payeeAgentId: payee,
            payTo: treasury,
            token: address(usd8),
            amount: amount,
            payer: address(0),
            issuedAt: uint64(block.timestamp),
            dueBy: 0,
            detailsHash: bytes32(0)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(businessKey, pay.hashInvoice(inv));
        sig = abi.encodePacked(r, s, v);
    }

    function _payCall(Invoice memory inv, bytes memory sig, address sessionKey) internal pure returns (bytes memory) {
        return abi.encodeCall(PayeeGuardAccount.payInvoice, (inv, sig, sessionKey));
    }

    function _op(bytes memory callData) internal view returns (PackedUserOperation memory op) {
        op = PackedUserOperation({
            sender: address(account),
            nonce: entryPoint.getNonce(address(account), 0),
            initCode: "",
            callData: callData,
            accountGasLimits: bytes32((uint256(600_000) << 128) | 600_000),
            preVerificationGas: 60_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | 2 gwei),
            paymasterAndData: "",
            signature: ""
        });
    }

    function _signSession(PackedUserOperation memory op, uint256 key, uint32 day) internal view {
        bytes32 digest = account.sessionDigest(entryPoint.getUserOpHash(op), day);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        op.signature = abi.encodePacked(uint8(1), vm.addr(key), day, r, s, v);
    }

    function _signOwner(PackedUserOperation memory op) internal view {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(entryPoint.getUserOpHash(op));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);
        op.signature = abi.encodePacked(r, s, v);
    }

    function _handle(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler, bundler);
        entryPoint.handleOps(ops, bundler);
    }

    function _expectAA23(bytes memory inner) internal {
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOpWithRevert.selector, 0, "AA23 reverted", inner));
    }

    function _sessionPay(uint256 payee, uint256 amount) internal returns (PackedUserOperation memory op) {
        (Invoice memory inv, bytes memory sig) = _invoice(payee, amount);
        op = _op(_payCall(inv, sig, agent));
        _signSession(op, agentKey, _today());
    }
}
