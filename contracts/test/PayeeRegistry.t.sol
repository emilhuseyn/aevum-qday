// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IdentityRegistryUpgradeable} from "erc8004/IdentityRegistryUpgradeable.sol";
import {IdentityDeployer} from "../script/IdentityDeployer.sol";
import {PayeeRegistry} from "../src/PayeeRegistry.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";

contract PayeeRegistryTest is Test {
    uint32 constant MIN = 60;
    uint32 constant DEFAULT = 48 hours;

    IdentityRegistryUpgradeable identity;
    PayeeRegistry registry;

    address business = makeAddr("business");
    address guardian = makeAddr("guardian");
    address attacker = makeAddr("attacker");
    address treasury = makeAddr("treasury");
    address newBank = makeAddr("newBank");
    address buyer = makeAddr("buyer");
    uint256 agentId;

    function setUp() public {
        vm.warp(1_763_280_000);
        identity = IdentityDeployer.deploy();
        registry = new PayeeRegistry(IIdentityRegistry(address(identity)), MIN, DEFAULT);
        vm.prank(business);
        agentId = identity.register("https://forela.example/.well-known/agent-registration.json");
    }

    function _status(address payee) internal view returns (PayeeRegistry.PayeeStatus status) {
        (status,) = registry.payeeInfo(agentId, payee);
    }

    function _activate(address payee) internal returns (uint64 activeAt) {
        vm.prank(business);
        activeAt = registry.requestPayee(agentId, payee);
        vm.warp(activeAt);
    }

    function _setGuardian() internal {
        vm.prank(business);
        assertTrue(registry.proposePolicy(agentId, DEFAULT, guardian));
    }

    // ------------------------------------------------------------------ deployment

    function test_identityIsOfficialErc8004() public view {
        assertEq(identity.getVersion(), "2.0.0");
        assertEq(identity.ownerOf(agentId), business);
        assertEq(registry.ownerOf(agentId), business);
    }

    function test_constructor_rejectsBadCoolingOff() public {
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.InvalidCoolingOff.selector, uint32(10)));
        new PayeeRegistry(IIdentityRegistry(address(identity)), 60, 10);
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.InvalidCoolingOff.selector, uint32(1)));
        new PayeeRegistry(IIdentityRegistry(address(identity)), 0, 1);
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.InvalidCoolingOff.selector, uint32(31 days)));
        new PayeeRegistry(IIdentityRegistry(address(identity)), 60, 31 days);
    }

    // ------------------------------------------------------------------ add -> cooling-off -> payable

    function test_request_coolsOffThenBecomesPayable() public {
        uint64 expected = uint64(block.timestamp) + DEFAULT;
        vm.expectEmit(true, true, true, true, address(registry));
        emit PayeeRegistry.PayeeChangeRequested(agentId, treasury, business, expected, false);
        vm.prank(business);
        uint64 activeAt = registry.requestPayee(agentId, treasury);
        assertEq(activeAt, expected);

        assertEq(uint8(_status(treasury)), uint8(PayeeRegistry.PayeeStatus.CoolingOff));
        assertFalse(registry.isPayable(agentId, treasury));
        vm.expectRevert(
            abi.encodeWithSelector(PayeeRegistry.PayeeInCoolingOff.selector, agentId, treasury, activeAt)
        );
        registry.requirePayable(agentId, treasury);

        vm.warp(activeAt - 1);
        assertFalse(registry.isPayable(agentId, treasury));

        vm.warp(activeAt);
        assertTrue(registry.isPayable(agentId, treasury));
        registry.requirePayable(agentId, treasury);
        assertEq(uint8(_status(treasury)), uint8(PayeeRegistry.PayeeStatus.Active));
    }

    function test_request_onlyIdentityOwner() public {
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.NotIdentityOwner.selector, agentId, attacker));
        vm.prank(attacker);
        registry.requestPayee(agentId, newBank);
    }

    function test_request_guardianCannotAdd() public {
        _setGuardian();
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.NotIdentityOwner.selector, agentId, guardian));
        vm.prank(guardian);
        registry.requestPayee(agentId, newBank);
    }

    function test_request_rejectsZeroAddress() public {
        vm.expectRevert(PayeeRegistry.InvalidPayee.selector);
        vm.prank(business);
        registry.requestPayee(agentId, address(0));
    }

    function test_request_rejectsDuplicateWhilePendingOrActive() public {
        vm.startPrank(business);
        registry.requestPayee(agentId, treasury);
        vm.expectRevert(
            abi.encodeWithSelector(
                PayeeRegistry.PayeeAlreadyListed.selector, agentId, treasury, PayeeRegistry.PayeeStatus.CoolingOff
            )
        );
        registry.requestPayee(agentId, treasury);
        vm.warp(block.timestamp + DEFAULT);
        vm.expectRevert(
            abi.encodeWithSelector(
                PayeeRegistry.PayeeAlreadyListed.selector, agentId, treasury, PayeeRegistry.PayeeStatus.Active
            )
        );
        registry.requestPayee(agentId, treasury);
        vm.stopPrank();
    }

    function test_request_unknownAgent() public {
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.NotIdentityOwner.selector, uint256(999), business));
        vm.prank(business);
        registry.requestPayee(999, treasury);
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.PayeeNotRegistered.selector, uint256(999), treasury));
        registry.requirePayable(999, treasury);
    }

    function test_requirePayable_unregistered() public {
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.PayeeNotRegistered.selector, agentId, newBank));
        registry.requirePayable(agentId, newBank);
    }

    // ------------------------------------------------------------------ cancel during the window

    function test_cancel_byOwnerDuringCoolingOff() public {
        vm.prank(business);
        registry.requestPayee(agentId, newBank);
        vm.warp(block.timestamp + DEFAULT - 1);

        vm.expectEmit(true, true, true, true, address(registry));
        emit PayeeRegistry.PayeeChangeCancelled(agentId, newBank, business);
        vm.prank(business);
        registry.cancelPayee(agentId, newBank);

        vm.warp(block.timestamp + 365 days);
        assertEq(uint8(_status(newBank)), uint8(PayeeRegistry.PayeeStatus.None));
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.PayeeNotRegistered.selector, agentId, newBank));
        registry.requirePayable(agentId, newBank);
    }

    function test_cancel_byGuardian() public {
        _setGuardian();
        vm.prank(business);
        registry.requestPayee(agentId, newBank);
        vm.prank(guardian);
        registry.cancelPayee(agentId, newBank);
        assertEq(uint8(_status(newBank)), uint8(PayeeRegistry.PayeeStatus.None));
    }

    function test_cancel_byStrangerReverts() public {
        vm.prank(business);
        registry.requestPayee(agentId, newBank);
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.NotOwnerOrGuardian.selector, agentId, attacker));
        vm.prank(attacker);
        registry.cancelPayee(agentId, newBank);
    }

    function test_cancel_afterActiveReverts() public {
        _activate(treasury);
        vm.expectRevert(
            abi.encodeWithSelector(
                PayeeRegistry.PayeeNotPending.selector, agentId, treasury, PayeeRegistry.PayeeStatus.Active
            )
        );
        vm.prank(business);
        registry.cancelPayee(agentId, treasury);
    }

    // ------------------------------------------------------------------ revoke is immediate

    function test_revoke_isImmediate() public {
        _activate(treasury);
        vm.expectEmit(true, true, true, true, address(registry));
        emit PayeeRegistry.PayeeRevoked(agentId, treasury, business);
        vm.prank(business);
        registry.revokePayee(agentId, treasury);

        assertFalse(registry.isPayable(agentId, treasury));
        vm.expectRevert(
            abi.encodeWithSelector(PayeeRegistry.PayeeWasRevoked.selector, agentId, treasury, uint64(block.timestamp))
        );
        registry.requirePayable(agentId, treasury);
    }

    function test_revoke_byGuardian() public {
        _setGuardian();
        vm.prank(business);
        registry.requestPayee(agentId, treasury);
        vm.prank(guardian);
        registry.approvePayee(agentId, treasury);
        vm.warp(block.timestamp + DEFAULT);
        vm.prank(guardian);
        registry.revokePayee(agentId, treasury);
        assertEq(uint8(_status(treasury)), uint8(PayeeRegistry.PayeeStatus.Revoked));
    }

    function test_revoke_pendingReverts() public {
        vm.prank(business);
        registry.requestPayee(agentId, treasury);
        vm.expectRevert(
            abi.encodeWithSelector(
                PayeeRegistry.PayeeNotActive.selector, agentId, treasury, PayeeRegistry.PayeeStatus.CoolingOff
            )
        );
        vm.prank(business);
        registry.revokePayee(agentId, treasury);
    }

    function test_revoke_byStrangerReverts() public {
        _activate(treasury);
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.NotOwnerOrGuardian.selector, agentId, attacker));
        vm.prank(attacker);
        registry.revokePayee(agentId, treasury);
    }

    function test_reRequestAfterRevoke_restartsCoolingOff() public {
        _activate(treasury);
        vm.prank(business);
        registry.revokePayee(agentId, treasury);
        vm.prank(business);
        uint64 activeAt = registry.requestPayee(agentId, treasury);
        assertEq(activeAt, uint64(block.timestamp) + DEFAULT);
        assertFalse(registry.isPayable(agentId, treasury));
        address[] memory list = registry.payeesOf(agentId);
        assertEq(list.length, 1, "no duplicate entries");
        assertEq(list[0], treasury);
    }

    // ------------------------------------------------------------------ guardian (second approver)

    function test_guardian_requiredBeforePayable() public {
        _setGuardian();
        vm.prank(business);
        uint64 activeAt = registry.requestPayee(agentId, newBank);
        vm.warp(activeAt + 30 days);
        assertEq(uint8(_status(newBank)), uint8(PayeeRegistry.PayeeStatus.AwaitingApproval));
        vm.expectRevert(
            abi.encodeWithSelector(PayeeRegistry.PayeeAwaitingApproval.selector, agentId, newBank, activeAt)
        );
        registry.requirePayable(agentId, newBank);

        vm.expectEmit(true, true, true, true, address(registry));
        emit PayeeRegistry.PayeeChangeApproved(agentId, newBank, guardian, activeAt);
        vm.prank(guardian);
        registry.approvePayee(agentId, newBank);
        assertTrue(registry.isPayable(agentId, newBank));
    }

    function test_guardian_approvalDoesNotSkipCoolingOff() public {
        _setGuardian();
        vm.prank(business);
        uint64 activeAt = registry.requestPayee(agentId, newBank);
        vm.prank(guardian);
        registry.approvePayee(agentId, newBank);
        assertEq(uint8(_status(newBank)), uint8(PayeeRegistry.PayeeStatus.CoolingOff));
        vm.warp(activeAt);
        assertTrue(registry.isPayable(agentId, newBank));
    }

    function test_guardian_onlyGuardianApproves() public {
        _setGuardian();
        vm.prank(business);
        registry.requestPayee(agentId, newBank);
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.NotGuardian.selector, agentId, business));
        vm.prank(business);
        registry.approvePayee(agentId, newBank);
    }

    function test_guardian_approveNonPendingReverts() public {
        _setGuardian();
        vm.expectRevert(
            abi.encodeWithSelector(
                PayeeRegistry.PayeeNotPending.selector, agentId, newBank, PayeeRegistry.PayeeStatus.None
            )
        );
        vm.prank(guardian);
        registry.approvePayee(agentId, newBank);
    }

    function test_noGuardian_approveReverts() public {
        vm.prank(business);
        registry.requestPayee(agentId, newBank);
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.NotGuardian.selector, agentId, attacker));
        vm.prank(attacker);
        registry.approvePayee(agentId, newBank);
    }

    // ------------------------------------------------------------------ policy: strengthen now, weaken later

    function test_policy_increaseIsImmediate() public {
        vm.prank(business);
        assertTrue(registry.proposePolicy(agentId, 7 days, address(0)));
        (uint32 coolingOff,,) = registry.policyOf(agentId);
        assertEq(coolingOff, 7 days);
        vm.prank(business);
        assertEq(registry.requestPayee(agentId, treasury), uint64(block.timestamp) + 7 days);
    }

    function test_policy_decreaseWaitsForCurrentCoolingOff() public {
        vm.prank(business);
        assertFalse(registry.proposePolicy(agentId, MIN, address(0)));
        (uint32 coolingOff,, PayeeRegistry.PendingPolicy memory pending) = registry.policyOf(agentId);
        assertEq(coolingOff, DEFAULT);
        assertEq(pending.coolingOff, MIN);
        assertEq(pending.effectiveAt, uint64(block.timestamp) + DEFAULT);

        vm.expectRevert(
            abi.encodeWithSelector(PayeeRegistry.PolicyNotYetEffective.selector, agentId, pending.effectiveAt)
        );
        registry.applyPolicy(agentId);

        // A payee requested meanwhile still gets the long cooling-off.
        vm.prank(business);
        assertEq(registry.requestPayee(agentId, newBank), uint64(block.timestamp) + DEFAULT);

        vm.warp(pending.effectiveAt);
        vm.prank(attacker); // anyone may apply once due
        registry.applyPolicy(agentId);
        (coolingOff,, pending) = registry.policyOf(agentId);
        assertEq(coolingOff, MIN);
        assertEq(pending.effectiveAt, 0);
    }

    function test_policy_removingGuardianIsDelayedAndCancellable() public {
        _setGuardian();
        vm.prank(business);
        assertFalse(registry.proposePolicy(agentId, DEFAULT, address(0)));
        vm.expectEmit(true, true, false, true, address(registry));
        emit PayeeRegistry.PolicyChangeCancelled(agentId, guardian);
        vm.prank(guardian);
        registry.cancelPolicy(agentId);
        (, address g, PayeeRegistry.PendingPolicy memory pending) = registry.policyOf(agentId);
        assertEq(g, guardian);
        assertEq(pending.effectiveAt, 0);
    }

    function test_policy_guardianApprovesWeakeningAtOnce() public {
        _setGuardian();
        vm.prank(business);
        registry.proposePolicy(agentId, MIN, guardian);
        vm.prank(guardian);
        registry.approvePolicy(agentId);
        (uint32 coolingOff, address g,) = registry.policyOf(agentId);
        assertEq(coolingOff, MIN);
        assertEq(g, guardian);
    }

    function test_policy_strengthenClearsPendingWeakening() public {
        vm.startPrank(business);
        registry.proposePolicy(agentId, MIN, address(0));
        registry.proposePolicy(agentId, 3 days, address(0));
        vm.stopPrank();
        (uint32 coolingOff,, PayeeRegistry.PendingPolicy memory pending) = registry.policyOf(agentId);
        assertEq(coolingOff, 3 days);
        assertEq(pending.effectiveAt, 0);
    }

    function test_policy_bounds() public {
        vm.startPrank(business);
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.InvalidCoolingOff.selector, uint32(MIN - 1)));
        registry.proposePolicy(agentId, MIN - 1, address(0));
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.InvalidCoolingOff.selector, uint32(31 days)));
        registry.proposePolicy(agentId, 31 days, address(0));
        vm.expectRevert(PayeeRegistry.InvalidGuardian.selector);
        registry.proposePolicy(agentId, DEFAULT, business);
        vm.stopPrank();
    }

    function test_policy_onlyOwnerProposes_onlyGuardianApproves() public {
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.NotIdentityOwner.selector, agentId, attacker));
        vm.prank(attacker);
        registry.proposePolicy(agentId, MIN, address(0));

        _setGuardian();
        vm.prank(business);
        registry.proposePolicy(agentId, MIN, guardian);
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.NotGuardian.selector, agentId, business));
        vm.prank(business);
        registry.approvePolicy(agentId);
    }

    function test_policy_noPendingReverts() public {
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.NoPendingPolicy.selector, agentId));
        registry.applyPolicy(agentId);
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.NoPendingPolicy.selector, agentId));
        vm.prank(business);
        registry.cancelPolicy(agentId);
        _setGuardian();
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.NoPendingPolicy.selector, agentId));
        vm.prank(guardian);
        registry.approvePolicy(agentId);
    }

    // ------------------------------------------------------------------ activation announcement (log only)

    function test_announceActivation() public {
        vm.prank(business);
        uint64 activeAt = registry.requestPayee(agentId, treasury);
        vm.expectRevert(
            abi.encodeWithSelector(
                PayeeRegistry.PayeeNotActive.selector, agentId, treasury, PayeeRegistry.PayeeStatus.CoolingOff
            )
        );
        registry.announceActivation(agentId, treasury);

        vm.warp(activeAt);
        vm.expectEmit(true, true, false, true, address(registry));
        emit PayeeRegistry.PayeeChangeActivated(agentId, treasury, activeAt);
        vm.prank(attacker);
        registry.announceActivation(agentId, treasury);

        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.ActivationAlreadyAnnounced.selector, agentId, treasury));
        registry.announceActivation(agentId, treasury);
    }

    // ------------------------------------------------------------------ invoice signer

    function test_invoiceSigner() public {
        address hot = makeAddr("invoicingHotKey");
        assertTrue(registry.isInvoiceSigner(agentId, business));
        assertFalse(registry.isInvoiceSigner(agentId, hot));
        vm.expectEmit(true, true, false, true, address(registry));
        emit PayeeRegistry.InvoiceSignerSet(agentId, hot);
        vm.prank(business);
        registry.setInvoiceSigner(agentId, hot);
        assertTrue(registry.isInvoiceSigner(agentId, hot));
        assertTrue(registry.isInvoiceSigner(agentId, business));
        assertFalse(registry.isInvoiceSigner(agentId, address(0)));
        assertFalse(registry.isInvoiceSigner(999, business));

        // The hot key cannot touch payout addresses.
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.NotIdentityOwner.selector, agentId, hot));
        vm.prank(hot);
        registry.requestPayee(agentId, newBank);

        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.NotIdentityOwner.selector, agentId, attacker));
        vm.prank(attacker);
        registry.setInvoiceSigner(agentId, attacker);
    }

    // ------------------------------------------------------------------ identity transfer resets everything

    function test_identityTransfer_clearsPayeesSignerAndPolicy() public {
        _activate(treasury);
        vm.startPrank(business);
        registry.setInvoiceSigner(agentId, makeAddr("hot"));
        registry.proposePolicy(agentId, 7 days, guardian);
        identity.transferFrom(business, buyer, agentId);
        vm.stopPrank();

        assertFalse(registry.isPayable(agentId, treasury));
        assertEq(registry.payeesOf(agentId).length, 0);
        assertEq(registry.invoiceSignerOf(agentId), address(0));
        assertFalse(registry.isInvoiceSigner(agentId, business));
        assertTrue(registry.isInvoiceSigner(agentId, buyer));
        (uint32 coolingOff, address g,) = registry.policyOf(agentId);
        assertEq(coolingOff, DEFAULT);
        assertEq(g, address(0));

        // The new owner starts from scratch, with the cooling-off.
        vm.prank(buyer);
        uint64 activeAt = registry.requestPayee(agentId, treasury);
        assertEq(activeAt, uint64(block.timestamp) + DEFAULT);
        // The old owner lost control.
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.NotOwnerOrGuardian.selector, agentId, business));
        vm.prank(business);
        registry.cancelPayee(agentId, treasury);
    }

    // ------------------------------------------------------------------ fuzz: never payable before activeAt

    function testFuzz_neverPayableBeforeCoolingOff(uint32 coolingOff, uint32 elapsed, address payee) public {
        vm.assume(payee != address(0));
        coolingOff = uint32(bound(coolingOff, DEFAULT, 30 days));
        vm.prank(business);
        registry.proposePolicy(agentId, coolingOff, address(0));
        vm.prank(business);
        uint64 activeAt = registry.requestPayee(agentId, payee);
        assertEq(activeAt, uint64(block.timestamp) + coolingOff);
        vm.warp(block.timestamp + elapsed);
        assertEq(registry.isPayable(agentId, payee), elapsed >= coolingOff);
    }
}
