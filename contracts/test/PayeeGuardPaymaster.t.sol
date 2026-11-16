// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Invoice} from "../src/InvoicePay.sol";
import {PayeeGuardAccount} from "../src/PayeeGuardAccount.sol";
import {PayeeGuardPaymaster} from "../src/PayeeGuardPaymaster.sol";
import {AccountFixture} from "./utils/AccountFixture.sol";

contract PayeeGuardPaymasterTest is AccountFixture {
    PayeeGuardPaymaster paymaster;
    address funder = makeAddr("onRamp");
    uint256 constant CREDIT = 50_000; // 0.05 tUSD8 of gas credit
    uint256 constant RATE = 1_000_000; // 1 tUSD8 per tQDAY

    function setUp() public override {
        super.setUp();
        paymaster = new PayeeGuardPaymaster(IEntryPoint(address(entryPoint)), IERC20(address(usd8)), RATE, 10_500);
        vm.deal(address(this), 10 ether);
        paymaster.deposit{value: 5 ether}();
        paymaster.addStake{value: 1 ether}(1 days);
        usd8.mint(funder, 1_000_000);
        vm.deal(address(account), 0); // the payer holds no native gas token at all
        vm.startPrank(funder);
        usd8.approve(address(paymaster), type(uint256).max);
        paymaster.depositFor(address(account), CREDIT);
        vm.stopPrank();
    }

    function _withPaymaster(PackedUserOperation memory op) internal view {
        op.paymasterAndData = abi.encodePacked(address(paymaster), uint128(120_000), uint128(80_000));
    }

    function test_sessionPayment_gasPaidInTUSD8() public {
        (Invoice memory inv, bytes memory sig) = _invoice(agentId, AMOUNT);
        PackedUserOperation memory op = _op(_payCall(inv, sig, agent));
        _withPaymaster(op);
        _signSession(op, agentKey, _today());
        uint256 depositBefore = paymaster.getDeposit();

        _handle(op);

        assertEq(address(account).balance, 0, "account never held tQDAY");
        assertEq(usd8.balanceOf(treasury), AMOUNT, "invoice paid");
        uint256 cost = CREDIT - paymaster.credit(address(account));
        assertGt(cost, 0, "gas charged in tUSD8");
        assertEq(paymaster.collected(), cost);
        assertLt(paymaster.getDeposit(), depositBefore, "paymaster paid the EntryPoint in native");
    }

    /// With gas limits close to what a bundler estimates, the tUSD8 charge covers what the paymaster paid the
    /// EntryPoint. (EntryPoint v0.7 adds a 10 % penalty on unused gas after postOp; the markup absorbs it.)
    function test_chargeCoversNativeSpend_withEstimatedLimits() public {
        (Invoice memory inv, bytes memory sig) = _invoice(agentId, AMOUNT);
        PackedUserOperation memory op = _op(_payCall(inv, sig, agent));
        op.accountGasLimits = bytes32((uint256(150_000) << 128) | 170_000);
        op.paymasterAndData = abi.encodePacked(address(paymaster), uint128(60_000), uint128(45_000));
        _signSession(op, agentKey, _today());
        uint256 depositBefore = paymaster.getDeposit();
        _handle(op);
        uint256 nativeSpent = depositBefore - paymaster.getDeposit();
        uint256 cost = CREDIT - paymaster.credit(address(account));
        uint256 costPrice = (nativeSpent * RATE + 1e18 - 1) / 1e18;
        assertGe(cost, costPrice, "paymaster does not run at a loss");
        assertLe(cost, costPrice * 2, "and does not overcharge wildly");
    }

    function test_insufficientCredit_rejectedAtValidation() public {
        vm.prank(address(account));
        paymaster.withdrawCredit(address(account), CREDIT - 1);
        (Invoice memory inv, bytes memory sig) = _invoice(agentId, AMOUNT);
        PackedUserOperation memory op = _op(_payCall(inv, sig, agent));
        _withPaymaster(op);
        _signSession(op, agentKey, _today());
        vm.expectPartialRevert(IEntryPoint.FailedOpWithRevert.selector);
        _handle(op);
        assertEq(usd8.balanceOf(treasury), 0);
    }

    function test_newAccount_deployedAndPaidWithoutNativeToken() public {
        address predicted = factory.getAddress(owner, 99);
        vm.prank(funder);
        paymaster.depositFor(predicted, CREDIT);
        uint256[] memory allowed = new uint256[](1);
        allowed[0] = agentId;
        PackedUserOperation memory op = PackedUserOperation({
            sender: predicted,
            nonce: 0,
            initCode: abi.encodePacked(address(factory), abi.encodeCall(factory.createAccount, (owner, 99))),
            callData: abi.encodeCall(PayeeGuardAccount.grantSession, (agent, _policy(), allowed)),
            accountGasLimits: bytes32((uint256(1_000_000) << 128) | 300_000),
            preVerificationGas: 60_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | 2 gwei),
            paymasterAndData: abi.encodePacked(address(paymaster), uint128(120_000), uint128(80_000)),
            signature: ""
        });
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ownerKey, MessageHashUtils.toEthSignedMessageHash(entryPoint.getUserOpHash(op)));
        op.signature = abi.encodePacked(r, s, v);
        _handle(op);
        assertGt(predicted.code.length, 0);
        assertEq(predicted.balance, 0);
        assertEq(PayeeGuardAccount(payable(predicted)).sessionOf(agent).grantId, 1);
        assertLt(paymaster.credit(predicted), CREDIT);
    }

    function test_withdrawCredit() public {
        vm.prank(address(account));
        paymaster.withdrawCredit(owner, 10_000);
        assertEq(usd8.balanceOf(owner), 10_000);
        assertEq(paymaster.credit(address(account)), CREDIT - 10_000);
        vm.expectRevert(abi.encodeWithSelector(PayeeGuardPaymaster.AmountTooHigh.selector, CREDIT, CREDIT - 10_000));
        vm.prank(address(account));
        paymaster.withdrawCredit(owner, CREDIT);
    }

    function test_owner_rateAndFees() public {
        vm.expectRevert(PayeeGuardPaymaster.InvalidRate.selector);
        paymaster.setRate(0, 10_000);
        vm.expectRevert(PayeeGuardPaymaster.InvalidRate.selector);
        paymaster.setRate(RATE, 9_999);
        vm.expectRevert(PayeeGuardPaymaster.InvalidRate.selector);
        paymaster.setRate(RATE, 20_001);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, funder));
        vm.prank(funder);
        paymaster.setRate(RATE, 10_000);

        // fees are only what was collected, never accounts' credit
        vm.expectRevert(abi.encodeWithSelector(PayeeGuardPaymaster.AmountTooHigh.selector, 1, 0));
        paymaster.withdrawFees(address(this), 1);
        _handle(_paidSessionOp());
        uint256 fees = paymaster.collected();
        paymaster.withdrawFees(address(this), fees);
        assertEq(usd8.balanceOf(address(this)), fees);
    }

    function test_quoteRoundsUp() public view {
        assertEq(paymaster.quote(1), 1);
        assertEq(paymaster.quote(1 ether), 1_050_000);
    }

    function _paidSessionOp() internal returns (PackedUserOperation memory op) {
        (Invoice memory inv, bytes memory sig) = _invoice(agentId, AMOUNT);
        op = _op(_payCall(inv, sig, agent));
        _withPaymaster(op);
        _signSession(op, agentKey, _today());
    }

    receive() external payable {}
}
