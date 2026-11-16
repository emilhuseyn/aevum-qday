// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IdentityRegistryUpgradeable} from "erc8004/IdentityRegistryUpgradeable.sol";
import {IdentityDeployer} from "../script/IdentityDeployer.sol";
import {PayeeRegistry} from "../src/PayeeRegistry.sol";
import {InvoicePay, Invoice} from "../src/InvoicePay.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {MockUSD8} from "./mocks/MockUSD8.sol";
import {Mock1271Wallet} from "./mocks/Mock1271Wallet.sol";

contract InvoicePayTest is Test {
    uint32 constant MIN = 60;
    uint32 constant DEFAULT = 48 hours;
    uint256 constant AMOUNT = 250_000; // 0.25 tUSD8

    IdentityRegistryUpgradeable identity;
    PayeeRegistry registry;
    InvoicePay pay;
    MockUSD8 usd8;

    uint256 businessKey;
    address business;
    uint256 payerKey;
    address payer;
    address treasury = makeAddr("treasury");
    address attackerWallet = makeAddr("attackerWallet");
    uint256 attackerKey;
    uint256 agentId;

    function setUp() public {
        vm.warp(1_763_280_000);
        (business, businessKey) = makeAddrAndKey("business");
        (payer, payerKey) = makeAddrAndKey("payer");
        (, attackerKey) = makeAddrAndKey("attacker");

        identity = IdentityDeployer.deploy();
        registry = new PayeeRegistry(IIdentityRegistry(address(identity)), MIN, DEFAULT);
        pay = new InvoicePay(registry);
        usd8 = new MockUSD8();

        vm.prank(business);
        agentId = identity.register("https://forela.example/.well-known/agent-registration.json");
        vm.prank(business);
        uint64 activeAt = registry.requestPayee(agentId, treasury);
        vm.warp(activeAt);

        usd8.mint(payer, 10_000_000);
        vm.prank(payer);
        usd8.approve(address(pay), type(uint256).max);
    }

    function _invoice(bytes32 id, address payTo, uint256 amount) internal view returns (Invoice memory) {
        return Invoice({
            invoiceId: id,
            payeeAgentId: agentId,
            payTo: payTo,
            token: address(usd8),
            amount: amount,
            payer: address(0),
            issuedAt: uint64(block.timestamp),
            dueBy: uint64(block.timestamp + 30 days),
            detailsHash: keccak256("INV-2026-0042: consulting, November")
        });
    }

    function _sign(Invoice memory inv, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, pay.hashInvoice(inv));
        return abi.encodePacked(r, s, v);
    }

    function _verdict(Invoice memory inv, bytes memory sig, address who)
        internal
        view
        returns (InvoicePay.Verdict verdict, uint64 at)
    {
        return pay.checkInvoice(inv, sig, who);
    }

    // ------------------------------------------------------------------ happy path

    function test_pay_happyPath() public {
        Invoice memory inv = _invoice("INV-0042", treasury, AMOUNT);
        bytes memory sig = _sign(inv, businessKey);
        (InvoicePay.Verdict verdict,) = _verdict(inv, sig, payer);
        assertEq(uint8(verdict), uint8(InvoicePay.Verdict.Payable));

        bytes32 key = pay.invoiceKey(agentId, inv.invoiceId);
        vm.expectEmit(true, true, true, true, address(pay));
        emit InvoicePay.InvoicePaid(
            key, agentId, payer, inv.invoiceId, treasury, address(usd8), AMOUNT, pay.hashInvoice(inv)
        );
        vm.prank(payer);
        assertEq(pay.payInvoice(inv, sig), key);

        assertEq(usd8.balanceOf(treasury), AMOUNT);
        assertEq(usd8.balanceOf(payer), 10_000_000 - AMOUNT);
        InvoicePay.Receipt memory receipt = pay.receiptOf(agentId, inv.invoiceId);
        assertEq(receipt.payer, payer);
        assertEq(receipt.paidAt, uint64(block.timestamp));
    }

    function test_pay_isIdempotent() public {
        Invoice memory inv = _invoice("INV-0042", treasury, AMOUNT);
        bytes memory sig = _sign(inv, businessKey);
        vm.prank(payer);
        bytes32 key = pay.payInvoice(inv, sig);

        vm.expectRevert(abi.encodeWithSelector(InvoicePay.InvoiceAlreadyPaid.selector, key, uint64(block.timestamp)));
        vm.prank(payer);
        pay.payInvoice(inv, sig);
        (InvoicePay.Verdict verdict, uint64 at) = _verdict(inv, sig, payer);
        assertEq(uint8(verdict), uint8(InvoicePay.Verdict.AlreadyPaid));
        assertEq(at, uint64(block.timestamp));
        assertEq(usd8.balanceOf(treasury), AMOUNT, "paid once");
    }

    // ------------------------------------------------------------------ the attack: "our bank details have changed"

    function test_newBankDetails_signedCorrectly_isBlockedByCoolingOff() public {
        // The attacker controls the business's key (stolen invoicing laptop) and adds their own payout address.
        vm.prank(business);
        uint64 activeAt = registry.requestPayee(agentId, attackerWallet);
        Invoice memory inv = _invoice("INV-0043", attackerWallet, AMOUNT);
        bytes memory sig = _sign(inv, businessKey); // a perfectly valid signature

        (InvoicePay.Verdict verdict, uint64 at) = _verdict(inv, sig, payer);
        assertEq(uint8(verdict), uint8(InvoicePay.Verdict.PayeeInCoolingOff));
        assertEq(at, activeAt);

        vm.expectRevert(
            abi.encodeWithSelector(PayeeRegistry.PayeeInCoolingOff.selector, agentId, attackerWallet, activeAt)
        );
        vm.prank(payer);
        pay.payInvoice(inv, sig);

        // The business sees PayeeChangeRequested and cancels inside the window: the address never becomes payable.
        vm.prank(business);
        registry.cancelPayee(agentId, attackerWallet);
        vm.warp(activeAt + 1 days);
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.PayeeNotRegistered.selector, agentId, attackerWallet));
        vm.prank(payer);
        pay.payInvoice(inv, sig);
        assertEq(usd8.balanceOf(attackerWallet), 0);
    }

    function test_unregisteredPayTo_isRefused() public {
        Invoice memory inv = _invoice("INV-0044", attackerWallet, AMOUNT);
        bytes memory sig = _sign(inv, businessKey);
        (InvoicePay.Verdict verdict,) = _verdict(inv, sig, payer);
        assertEq(uint8(verdict), uint8(InvoicePay.Verdict.PayeeNotRegistered));
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.PayeeNotRegistered.selector, agentId, attackerWallet));
        vm.prank(payer);
        pay.payInvoice(inv, sig);
    }

    function test_revokedPayee_isRefused() public {
        vm.prank(business);
        registry.revokePayee(agentId, treasury);
        Invoice memory inv = _invoice("INV-0045", treasury, AMOUNT);
        bytes memory sig = _sign(inv, businessKey);
        (InvoicePay.Verdict verdict, uint64 at) = _verdict(inv, sig, payer);
        assertEq(uint8(verdict), uint8(InvoicePay.Verdict.PayeeRevoked));
        assertEq(at, uint64(block.timestamp));
        vm.expectRevert(
            abi.encodeWithSelector(PayeeRegistry.PayeeWasRevoked.selector, agentId, treasury, uint64(block.timestamp))
        );
        vm.prank(payer);
        pay.payInvoice(inv, sig);
    }

    function test_payeeAwaitingGuardian_isRefused() public {
        address guardian = makeAddr("guardian");
        address second = makeAddr("secondAccount");
        vm.startPrank(business);
        registry.proposePolicy(agentId, DEFAULT, guardian);
        uint64 activeAt = registry.requestPayee(agentId, second);
        vm.stopPrank();
        vm.warp(activeAt);
        Invoice memory inv = _invoice("INV-0046", second, AMOUNT);
        bytes memory sig = _sign(inv, businessKey);
        (InvoicePay.Verdict verdict,) = _verdict(inv, sig, payer);
        assertEq(uint8(verdict), uint8(InvoicePay.Verdict.PayeeAwaitingApproval));
        vm.expectRevert(
            abi.encodeWithSelector(PayeeRegistry.PayeeAwaitingApproval.selector, agentId, second, activeAt)
        );
        vm.prank(payer);
        pay.payInvoice(inv, sig);

        vm.prank(guardian);
        registry.approvePayee(agentId, second);
        vm.prank(payer);
        pay.payInvoice(inv, sig);
        assertEq(usd8.balanceOf(second), AMOUNT);
    }

    // ------------------------------------------------------------------ signatures

    function test_signatureByStranger_isRefused() public {
        Invoice memory inv = _invoice("INV-0047", treasury, AMOUNT);
        bytes memory sig = _sign(inv, attackerKey);
        (InvoicePay.Verdict verdict,) = _verdict(inv, sig, payer);
        assertEq(uint8(verdict), uint8(InvoicePay.Verdict.BadSignature));
        vm.expectRevert(InvoicePay.InvalidInvoiceSignature.selector);
        vm.prank(payer);
        pay.payInvoice(inv, sig);
    }

    function test_tamperedAmount_isRefused() public {
        Invoice memory inv = _invoice("INV-0048", treasury, AMOUNT);
        bytes memory sig = _sign(inv, businessKey);
        inv.amount = AMOUNT * 20;
        vm.expectRevert(InvoicePay.InvalidInvoiceSignature.selector);
        vm.prank(payer);
        pay.payInvoice(inv, sig);
    }

    function test_malformedSignature_isRefused() public {
        Invoice memory inv = _invoice("INV-0049", treasury, AMOUNT);
        vm.expectRevert(InvoicePay.InvalidInvoiceSignature.selector);
        vm.prank(payer);
        pay.payInvoice(inv, hex"deadbeef");
    }

    function test_invoiceSignerHotKey() public {
        (address hot, uint256 hotKey) = makeAddrAndKey("invoicingHotKey");
        Invoice memory inv = _invoice("INV-0050", treasury, AMOUNT);
        bytes memory sig = _sign(inv, hotKey);
        (InvoicePay.Verdict verdict,) = _verdict(inv, sig, payer);
        assertEq(uint8(verdict), uint8(InvoicePay.Verdict.BadSignature));

        vm.prank(business);
        registry.setInvoiceSigner(agentId, hot);
        vm.prank(payer);
        pay.payInvoice(inv, sig);
        assertEq(usd8.balanceOf(treasury), AMOUNT);
    }

    function test_contractOwnedIdentity_erc1271() public {
        (address walletSigner, uint256 walletKey) = makeAddrAndKey("walletSigner");
        Mock1271Wallet wallet = new Mock1271Wallet(walletSigner);
        address payout = makeAddr("contractPayout");
        vm.startPrank(walletSigner);
        uint256 id = abi.decode(
            wallet.call(address(identity), abi.encodeWithSignature("register(string)", "https://acme.example/agent.json")),
            (uint256)
        );
        wallet.call(address(registry), abi.encodeCall(PayeeRegistry.requestPayee, (id, payout)));
        vm.stopPrank();
        vm.warp(block.timestamp + DEFAULT);

        Invoice memory inv = _invoice("ACME-1", payout, AMOUNT);
        inv.payeeAgentId = id;
        bytes memory sig = _sign(inv, walletKey); // wallet validates its signer's ECDSA signature via ERC-1271
        vm.prank(payer);
        pay.payInvoice(inv, sig);
        assertEq(usd8.balanceOf(payout), AMOUNT);
    }

    function test_identityTransfer_invalidatesOldSignaturesAndPayees() public {
        Invoice memory inv = _invoice("INV-0051", treasury, AMOUNT);
        bytes memory sig = _sign(inv, businessKey);
        vm.prank(business);
        identity.transferFrom(business, makeAddr("buyer"), agentId);
        (InvoicePay.Verdict verdict,) = _verdict(inv, sig, payer);
        assertEq(uint8(verdict), uint8(InvoicePay.Verdict.BadSignature));
    }

    // ------------------------------------------------------------------ invoice terms

    function test_expired_isRefused() public {
        Invoice memory inv = _invoice("INV-0052", treasury, AMOUNT);
        bytes memory sig = _sign(inv, businessKey);
        vm.warp(inv.dueBy + 1);
        vm.expectRevert(abi.encodeWithSelector(InvoicePay.InvoiceExpired.selector, inv.dueBy));
        vm.prank(payer);
        pay.payInvoice(inv, sig);
    }

    function test_noExpiryWhenDueByZero() public {
        Invoice memory inv = _invoice("INV-0053", treasury, AMOUNT);
        inv.dueBy = 0;
        bytes memory sig = _sign(inv, businessKey);
        vm.warp(block.timestamp + 3650 days);
        vm.prank(payer);
        pay.payInvoice(inv, sig);
    }

    function test_wrongPayer_isRefused() public {
        Invoice memory inv = _invoice("INV-0054", treasury, AMOUNT);
        inv.payer = makeAddr("someoneElse");
        bytes memory sig = _sign(inv, businessKey);
        vm.expectRevert(abi.encodeWithSelector(InvoicePay.WrongPayer.selector, inv.payer, payer));
        vm.prank(payer);
        pay.payInvoice(inv, sig);

        inv.payer = payer;
        sig = _sign(inv, businessKey);
        vm.prank(payer);
        pay.payInvoice(inv, sig);
    }

    function test_zeroAmount_isRefused() public {
        Invoice memory inv = _invoice("INV-0055", treasury, 0);
        bytes memory sig = _sign(inv, businessKey);
        vm.expectRevert(InvoicePay.ZeroAmount.selector);
        vm.prank(payer);
        pay.payInvoice(inv, sig);
    }

    function test_insufficientAllowance_revertsWithoutReceipt() public {
        Invoice memory inv = _invoice("INV-0056", treasury, AMOUNT);
        bytes memory sig = _sign(inv, businessKey);
        vm.prank(payer);
        usd8.approve(address(pay), 0);
        vm.prank(payer);
        vm.expectRevert();
        pay.payInvoice(inv, sig);
        assertEq(pay.receiptOf(agentId, inv.invoiceId).paidAt, 0);
    }

    // ------------------------------------------------------------------ permit

    function _permit(uint256 value, uint256 deadline) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                payer,
                address(pay),
                value,
                usd8.nonces(payer),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usd8.DOMAIN_SEPARATOR(), structHash));
        return vm.sign(payerKey, digest);
    }

    function test_payWithPermit_noPriorApproval() public {
        vm.prank(payer);
        usd8.approve(address(pay), 0);
        Invoice memory inv = _invoice("INV-0057", treasury, AMOUNT);
        bytes memory sig = _sign(inv, businessKey);
        (uint8 v, bytes32 r, bytes32 s) = _permit(AMOUNT, block.timestamp + 1 hours);
        vm.prank(payer);
        pay.payInvoiceWithPermit(inv, sig, block.timestamp + 1 hours, v, r, s);
        assertEq(usd8.balanceOf(treasury), AMOUNT);
        assertEq(usd8.allowance(payer, address(pay)), 0);
    }

    function test_payWithPermit_frontRunPermitStillPays() public {
        vm.prank(payer);
        usd8.approve(address(pay), 0);
        Invoice memory inv = _invoice("INV-0058", treasury, AMOUNT);
        bytes memory sig = _sign(inv, businessKey);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permit(AMOUNT, deadline);
        usd8.permit(payer, address(pay), AMOUNT, deadline, v, r, s); // someone submits the permit first
        vm.prank(payer);
        pay.payInvoiceWithPermit(inv, sig, deadline, v, r, s);
        assertEq(usd8.balanceOf(treasury), AMOUNT);
    }

    // ------------------------------------------------------------------ calldata layout the session-key policy relies on

    function test_calldataLayout_invoiceIsInline() public view {
        Invoice memory inv = _invoice("INV-0059", treasury, 123_456);
        bytes memory data = abi.encodeCall(InvoicePay.payInvoice, (inv, hex"0102"));
        assertEq(bytes4(data), InvoicePay.payInvoice.selector);
        assertEq(_word(data, 1), agentId);
        assertEq(address(uint160(_word(data, 2))), treasury);
        assertEq(address(uint160(_word(data, 3))), address(usd8));
        assertEq(_word(data, 4), 123_456);
        assertEq(address(uint160(_word(data, 5))), address(0));
    }

    function _word(bytes memory data, uint256 i) internal pure returns (uint256 w) {
        assembly {
            w := mload(add(add(data, 36), mul(i, 32)))
        }
    }

    function test_hashInvoice_matchesEip712() public view {
        Invoice memory inv = _invoice("INV-0060", treasury, AMOUNT);
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("PayeeGuard InvoicePay"),
                keccak256("1"),
                block.chainid,
                address(pay)
            )
        );
        assertEq(pay.domainSeparator(), domain);
        bytes32 structHash = keccak256(abi.encode(pay.INVOICE_TYPEHASH(), inv));
        assertEq(pay.hashInvoice(inv), keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
    }

    // ------------------------------------------------------------------ fuzz: only active payees ever receive money

    function testFuzz_onlyActivePayeeReceives(address payTo, uint32 elapsed) public {
        vm.assume(payTo != address(0) && payTo != treasury && payTo != payer && payTo.code.length == 0);
        vm.prank(business);
        uint64 activeAt = registry.requestPayee(agentId, payTo);
        vm.warp(block.timestamp + elapsed);
        Invoice memory inv = _invoice(keccak256(abi.encode(payTo, elapsed)), payTo, AMOUNT);
        inv.dueBy = 0;
        bytes memory sig = _sign(inv, businessKey);
        vm.prank(payer);
        if (block.timestamp < activeAt) {
            vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.PayeeInCoolingOff.selector, agentId, payTo, activeAt));
            pay.payInvoice(inv, sig);
            assertEq(usd8.balanceOf(payTo), 0);
        } else {
            pay.payInvoice(inv, sig);
            assertEq(usd8.balanceOf(payTo), AMOUNT);
        }
    }
}
