// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IdentityRegistryUpgradeable} from "erc8004/IdentityRegistryUpgradeable.sol";
import {IdentityDeployer} from "../script/IdentityDeployer.sol";
import {PayeeRegistry} from "../src/PayeeRegistry.sol";
import {InvoicePay, Invoice} from "../src/InvoicePay.sol";
import {PayeeGuardAccount} from "../src/PayeeGuardAccount.sol";
import {PayeeGuardAccountFactory} from "../src/PayeeGuardAccountFactory.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {MockUSD8} from "./mocks/MockUSD8.sol";

contract PayeeGuardAccountTest is Test {
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

    function setUp() public {
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

    // ------------------------------------------------------------------ session: happy path

    function test_session_paysInvoiceWithinPolicy() public {
        (Invoice memory inv, bytes memory sig) = _invoice(agentId, AMOUNT);
        PackedUserOperation memory op = _op(_payCall(inv, sig, agent));
        _signSession(op, agentKey, _today());

        vm.expectEmit(true, true, true, false, address(account));
        emit PayeeGuardAccount.InvoicePaidFromAccount(agent, agentId, inv.invoiceId, address(usd8), AMOUNT, bytes32(0));
        _handle(op);

        assertEq(usd8.balanceOf(treasury), AMOUNT);
        assertEq(usd8.allowance(address(account), address(pay)), 0, "no standing allowance");
        assertEq(account.spentOn(agent, _today()), AMOUNT);
        assertEq(pay.receiptOf(agentId, inv.invoiceId).payer, address(account));
    }

    function test_session_validationWindowIsTodayAndSession() public {
        PackedUserOperation memory op = _sessionPay(agentId, AMOUNT);
        bytes32 userOpHash = entryPoint.getUserOpHash(op);
        vm.prank(address(entryPoint));
        uint256 data = account.validateUserOp(op, userOpHash, 0);
        uint48 validUntil = uint48(data >> 160);
        uint48 validAfter = uint48(data >> 208);
        assertEq(uint160(data), 0, "signature ok");
        assertEq(validAfter, uint48(block.timestamp), "session start (granted after midnight)");
        assertEq(validUntil, uint48(uint256(_today()) * 1 days + 1 days - 1), "end of the UTC day");
    }

    // ------------------------------------------------------------------ session: policy enforced in validation

    function test_session_overPerPaymentCap_rejectedAtValidation() public {
        PackedUserOperation memory op = _sessionPay(agentId, 5_000_000);
        _expectAA23(
            abi.encodeWithSelector(PayeeGuardAccount.SessionPerPaymentCapExceeded.selector, 5_000_000, PER_PAYMENT)
        );
        _handle(op);
        assertEq(usd8.balanceOf(treasury), 0);
    }

    function test_session_dailyCap_resetsNextDay() public {
        _handle(_sessionPay(agentId, PER_PAYMENT));
        PackedUserOperation memory op = _sessionPay(agentId, PER_PAYMENT);
        _expectAA23(
            abi.encodeWithSelector(
                PayeeGuardAccount.SessionDailyCapExceeded.selector, _today(), uint256(2 * PER_PAYMENT), uint256(DAILY)
            )
        );
        _handle(op);

        vm.warp(block.timestamp + 1 days);
        _handle(_sessionPay(agentId, PER_PAYMENT));
        assertEq(usd8.balanceOf(treasury), 2 * PER_PAYMENT);
    }

    function test_session_payeeNotAllowlisted() public {
        PackedUserOperation memory op = _sessionPay(otherAgentId, AMOUNT);
        _expectAA23(abi.encodeWithSelector(PayeeGuardAccount.SessionPayeeNotAllowed.selector, otherAgentId));
        _handle(op);
    }

    function test_session_wrongToken() public {
        MockUSD8 other = new MockUSD8();
        (Invoice memory inv, bytes memory sig) = _invoice(agentId, AMOUNT);
        inv.token = address(other);
        PackedUserOperation memory op = _op(_payCall(inv, sig, agent));
        _signSession(op, agentKey, _today());
        _expectAA23(abi.encodeWithSelector(PayeeGuardAccount.SessionTokenNotAllowed.selector, address(other)));
        _handle(op);
    }

    function test_session_cannotCallAnythingElse() public {
        bytes memory drain = abi.encodeCall(
            PayeeGuardAccount.execute, (address(usd8), 0, abi.encodeCall(usd8.transfer, (agent, 1_000_000)))
        );
        PackedUserOperation memory op = _op(drain);
        _signSession(op, agentKey, _today());
        _expectAA23(
            abi.encodeWithSelector(PayeeGuardAccount.SessionCallNotAllowed.selector, PayeeGuardAccount.execute.selector)
        );
        _handle(op);

        uint256[] memory none = new uint256[](0);
        PayeeGuardAccount.SessionPolicy memory bigger = _policy();
        bigger.perPaymentCap = type(uint128).max;
        bigger.dailyCap = type(uint128).max;
        bigger.restrictPayees = false;
        op = _op(abi.encodeCall(PayeeGuardAccount.grantSession, (agent, bigger, none)));
        _signSession(op, agentKey, _today());
        _expectAA23(
            abi.encodeWithSelector(
                PayeeGuardAccount.SessionCallNotAllowed.selector, PayeeGuardAccount.grantSession.selector
            )
        );
        _handle(op);
        assertEq(usd8.balanceOf(agent), 0);
    }

    function test_session_mustNameItself() public {
        (Invoice memory inv, bytes memory sig) = _invoice(agentId, AMOUNT);
        PackedUserOperation memory op = _op(_payCall(inv, sig, makeAddr("someoneElse")));
        _signSession(op, agentKey, _today());
        _expectAA23(
            abi.encodeWithSelector(PayeeGuardAccount.SessionKeyMismatch.selector, agent, makeAddr("someoneElse"))
        );
        _handle(op);
    }

    function test_session_badSignature_AA24() public {
        (, uint256 strangerKey) = makeAddrAndKey("stranger");
        PackedUserOperation memory op = _sessionPay(agentId, AMOUNT);
        bytes32 digest = account.sessionDigest(entryPoint.getUserOpHash(op), _today());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(strangerKey, digest);
        op.signature = abi.encodePacked(uint8(1), agent, _today(), r, s, v); // names the agent, signed by a stranger
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        _handle(op);
    }

    function test_session_unknownKey() public {
        (address stranger, uint256 strangerKey) = makeAddrAndKey("stranger");
        (Invoice memory inv, bytes memory sig) = _invoice(agentId, AMOUNT);
        PackedUserOperation memory op = _op(_payCall(inv, sig, stranger));
        _signSession(op, strangerKey, _today());
        _expectAA23(abi.encodeWithSelector(PayeeGuardAccount.SessionNotActive.selector, stranger));
        _handle(op);
    }

    // ------------------------------------------------------------------ time limits via validAfter / validUntil

    function test_session_expired_AA22() public {
        vm.warp(block.timestamp + 8 days);
        PackedUserOperation memory op = _sessionPay(agentId, AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA22 expired or not due"));
        _handle(op);
    }

    function test_session_staleDay_AA22() public {
        (Invoice memory inv, bytes memory sig) = _invoice(agentId, AMOUNT);
        PackedUserOperation memory op = _op(_payCall(inv, sig, agent));
        _signSession(op, agentKey, _today());
        vm.warp(block.timestamp + 1 days); // signed for yesterday, submitted today
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA22 expired or not due"));
        _handle(op);
    }

    function test_session_futureDay_AA22() public {
        (Invoice memory inv, bytes memory sig) = _invoice(agentId, AMOUNT);
        PackedUserOperation memory op = _op(_payCall(inv, sig, agent));
        _signSession(op, agentKey, _today() + 1); // trying to borrow tomorrow's budget
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA22 expired or not due"));
        _handle(op);
    }

    // ------------------------------------------------------------------ revocation

    function test_revoke_nextOpFailsImmediately() public {
        _handle(_sessionPay(agentId, AMOUNT));
        vm.expectEmit(true, true, false, true, address(account));
        emit PayeeGuardAccount.SessionRevoked(agent, 1);
        vm.prank(owner);
        account.revokeSession(agent);

        PackedUserOperation memory op = _sessionPay(agentId, AMOUNT);
        _expectAA23(abi.encodeWithSelector(PayeeGuardAccount.SessionNotActive.selector, agent));
        _handle(op);
        assertEq(usd8.balanceOf(treasury), AMOUNT);
        assertFalse(account.isPayeeAllowed(agent, agentId));
    }

    function test_revoke_viaOwnerUserOp() public {
        PackedUserOperation memory op = _op(abi.encodeCall(PayeeGuardAccount.revokeSession, (agent)));
        _signOwner(op);
        _handle(op);
        assertEq(account.sessionOf(agent).grantId, 0);
    }

    function test_regrant_newAllowlistDoesNotInheritOld() public {
        uint256[] memory onlyOther = new uint256[](1);
        onlyOther[0] = otherAgentId;
        vm.prank(owner);
        account.grantSession(agent, _policy(), onlyOther);
        assertFalse(account.isPayeeAllowed(agent, agentId));
        assertTrue(account.isPayeeAllowed(agent, otherAgentId));
    }

    // ------------------------------------------------------------------ execution-time refusals still protect

    function test_session_payeeInCoolingOff_failsInExecution() public {
        address newBank = makeAddr("newBank");
        vm.prank(business);
        registry.requestPayee(agentId, newBank);
        (Invoice memory inv, bytes memory sig) = _invoice(agentId, AMOUNT);
        inv.payTo = newBank;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(businessKey, pay.hashInvoice(inv));
        sig = abi.encodePacked(r, s, v);
        PackedUserOperation memory op = _op(_payCall(inv, sig, agent));
        _signSession(op, agentKey, _today());

        vm.recordLogs();
        _handle(op);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawRevertReason;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IEntryPoint.UserOperationRevertReason.selector) sawRevertReason = true;
        }
        assertTrue(sawRevertReason, "InvoicePay refusal surfaces as UserOperationRevertReason");
        assertEq(usd8.balanceOf(newBank), 0);
        assertEq(account.spentOn(agent, _today()), AMOUNT, "validation budget is consumed even if execution fails");
    }

    // ------------------------------------------------------------------ owner

    function test_owner_canPayAboveSessionCap_andExecute() public {
        (Invoice memory inv, bytes memory sig) = _invoice(agentId, 5_000_000);
        PackedUserOperation memory op = _op(_payCall(inv, sig, address(0)));
        _signOwner(op);
        _handle(op);
        assertEq(usd8.balanceOf(treasury), 5_000_000);

        op = _op(abi.encodeCall(PayeeGuardAccount.execute, (address(usd8), 0, abi.encodeCall(usd8.transfer, (owner, 1)))));
        _signOwner(op);
        _handle(op);
        assertEq(usd8.balanceOf(owner), 1);
    }

    function test_owner_badSignature_AA24() public {
        PackedUserOperation memory op = _op(abi.encodeCall(PayeeGuardAccount.revokeSession, (agent)));
        (, uint256 strangerKey) = makeAddrAndKey("stranger");
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(strangerKey, MessageHashUtils.toEthSignedMessageHash(entryPoint.getUserOpHash(op)));
        op.signature = abi.encodePacked(r, s, v);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        _handle(op);
    }

    function test_onlyOwnerManagesSessions() public {
        uint256[] memory none = new uint256[](0);
        vm.expectRevert(abi.encodeWithSelector(PayeeGuardAccount.NotOwnerOrEntryPoint.selector, agent));
        vm.prank(agent);
        account.grantSession(agent, _policy(), none);
        vm.expectRevert(abi.encodeWithSelector(PayeeGuardAccount.NotOwnerOrEntryPoint.selector, agent));
        vm.prank(agent);
        account.revokeSession(agent);
        vm.expectRevert(abi.encodeWithSelector(PayeeGuardAccount.NotOwnerOrEntryPoint.selector, agent));
        vm.prank(agent);
        account.execute(address(usd8), 0, "");
    }

    function test_grantSession_rejectsBadPolicies() public {
        uint256[] memory none = new uint256[](0);
        uint256[] memory one = new uint256[](1);
        PayeeGuardAccount.SessionPolicy memory p = _policy();
        vm.startPrank(owner);

        vm.expectRevert(PayeeGuardAccount.InvalidSessionPolicy.selector);
        account.grantSession(address(0), p, one);
        vm.expectRevert(PayeeGuardAccount.InvalidSessionPolicy.selector);
        account.grantSession(owner, p, one);
        vm.expectRevert(PayeeGuardAccount.InvalidSessionPolicy.selector);
        account.grantSession(agent, p, none); // restrictPayees with an empty allowlist

        p.dailyCap = p.perPaymentCap - 1;
        vm.expectRevert(PayeeGuardAccount.InvalidSessionPolicy.selector);
        account.grantSession(agent, p, one);

        p = _policy();
        p.validUntil = p.validAfter;
        vm.expectRevert(PayeeGuardAccount.InvalidSessionPolicy.selector);
        account.grantSession(agent, p, one);

        p = _policy();
        p.token = address(0);
        vm.expectRevert(PayeeGuardAccount.InvalidSessionPolicy.selector);
        account.grantSession(agent, p, one);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ counterfactual deployment through initCode

    function test_factory_deploysThroughInitCode() public {
        address predicted = factory.getAddress(owner, 7);
        assertEq(predicted.code.length, 0);
        vm.deal(predicted, 1 ether);
        PackedUserOperation memory op = PackedUserOperation({
            sender: predicted,
            nonce: 0,
            initCode: abi.encodePacked(address(factory), abi.encodeCall(factory.createAccount, (owner, 7))),
            callData: abi.encodeCall(PayeeGuardAccount.execute, (owner, 0, "")),
            accountGasLimits: bytes32((uint256(1_000_000) << 128) | 200_000),
            preVerificationGas: 60_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | 2 gwei),
            paymasterAndData: "",
            signature: ""
        });
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ownerKey, MessageHashUtils.toEthSignedMessageHash(entryPoint.getUserOpHash(op)));
        op.signature = abi.encodePacked(r, s, v);
        _handle(op);
        assertGt(predicted.code.length, 0);
        assertEq(PayeeGuardAccount(payable(predicted)).owner(), owner);
        assertEq(address(factory.createAccount(owner, 7)), predicted, "idempotent");
    }

    // ------------------------------------------------------------------ ERC-1271

    function test_erc1271() public view {
        bytes32 hash = keccak256("PayeeGuard");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, hash);
        assertEq(account.isValidSignature(hash, abi.encodePacked(r, s, v)), account.isValidSignature.selector);
        (v, r, s) = vm.sign(agentKey, hash);
        assertEq(account.isValidSignature(hash, abi.encodePacked(r, s, v)), bytes4(0));
    }

    // ------------------------------------------------------------------ fuzz: the cap is exact

    function testFuzz_perPaymentCapIsExact(uint256 amount) public {
        amount = bound(amount, 1, 2 * PER_PAYMENT);
        PackedUserOperation memory op = _sessionPay(agentId, amount);
        if (amount > PER_PAYMENT) {
            _expectAA23(
                abi.encodeWithSelector(PayeeGuardAccount.SessionPerPaymentCapExceeded.selector, amount, PER_PAYMENT)
            );
            _handle(op);
            assertEq(usd8.balanceOf(treasury), 0);
        } else {
            _handle(op);
            assertEq(usd8.balanceOf(treasury), amount);
        }
    }
}
