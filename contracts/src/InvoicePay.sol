// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PayeeRegistry} from "./PayeeRegistry.sol";

/// @notice An invoice as the business signs it (EIP-712). It can travel by email or PDF; the signature is what counts.
/// @dev Every field is static, so `payInvoice(Invoice,bytes)` calldata holds the invoice inline right after the
/// selector (word i at offset 4 + 32*i). The session-key policy in the payer's smart account relies on this layout.
struct Invoice {
    bytes32 invoiceId; // business's own reference; unique per payee identity
    uint256 payeeAgentId; // ERC-8004 identity of the business
    address payTo; // must be an active payout address of payeeAgentId in PayeeRegistry
    address token; // ERC-20 to pay in (tUSD8 on Aevum)
    uint256 amount; // token base units
    address payer; // who may pay; address(0) = anyone
    uint64 issuedAt;
    uint64 dueBy; // last second the invoice can be paid; 0 = no expiry
    bytes32 detailsHash; // hash of the human-readable invoice (line items, PDF)
}

/// @title InvoicePay
/// @notice Pays EIP-712 signed invoices only to payout addresses that PayeeRegistry says are active, once per invoice.
contract InvoicePay is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Verdict {
        Payable,
        ZeroAmount,
        Expired,
        WrongPayer,
        AlreadyPaid,
        BadSignature,
        PayeeNotRegistered,
        PayeeAwaitingApproval,
        PayeeInCoolingOff,
        PayeeRevoked
    }

    struct Receipt {
        address payer;
        uint64 paidAt;
    }

    bytes32 public constant INVOICE_TYPEHASH = keccak256(
        "Invoice(bytes32 invoiceId,uint256 payeeAgentId,address payTo,address token,uint256 amount,address payer,uint64 issuedAt,uint64 dueBy,bytes32 detailsHash)"
    );

    PayeeRegistry public immutable registry;

    mapping(bytes32 key => Receipt) private _receipts;

    event InvoicePaid(
        bytes32 indexed key,
        uint256 indexed payeeAgentId,
        address indexed payer,
        bytes32 invoiceId,
        address payTo,
        address token,
        uint256 amount,
        bytes32 digest
    );

    error ZeroAmount();
    error InvoiceExpired(uint64 dueBy);
    error WrongPayer(address expected, address caller);
    error InvoiceAlreadyPaid(bytes32 key, uint64 paidAt);
    error InvalidInvoiceSignature();

    constructor(PayeeRegistry registry_) EIP712("PayeeGuard InvoicePay", "1") {
        registry = registry_;
    }

    /// @notice Pays `inv` from msg.sender (needs an allowance to this contract). Reverts with the reason on refusal.
    function payInvoice(Invoice calldata inv, bytes calldata signature) external nonReentrant returns (bytes32 key) {
        return _pay(inv, signature);
    }

    /// @notice Same as payInvoice, with an EIP-2612 permit for exactly `inv.amount` in the same transaction.
    /// @dev The permit is tried and ignored on failure (it may have been front-run); the transfer then needs allowance.
    function payInvoiceWithPermit(
        Invoice calldata inv,
        bytes calldata signature,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (bytes32 key) {
        try IERC20Permit(inv.token).permit(msg.sender, address(this), inv.amount, deadline, v, r, s) {} catch {}
        return _pay(inv, signature);
    }

    /// @notice Non-reverting pre-check for wallets and the assistant. `at` is dueBy, paidAt or the payee's activeAt /
    /// revokedAt depending on the verdict.
    function checkInvoice(Invoice calldata inv, bytes calldata signature, address payer)
        external
        view
        returns (Verdict verdict, uint64 at)
    {
        (verdict, at,) = _check(inv, signature, payer);
    }

    function hashInvoice(Invoice calldata inv) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(INVOICE_TYPEHASH, inv)));
    }

    function invoiceKey(uint256 payeeAgentId, bytes32 invoiceId) public pure returns (bytes32) {
        return keccak256(abi.encode(payeeAgentId, invoiceId));
    }

    function receiptOf(uint256 payeeAgentId, bytes32 invoiceId) external view returns (Receipt memory) {
        return _receipts[invoiceKey(payeeAgentId, invoiceId)];
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ----------------------------------------------------------------------------------------------------------------

    function _pay(Invoice calldata inv, bytes calldata signature) private returns (bytes32 key) {
        Verdict verdict;
        uint64 at;
        (verdict, at, key) = _check(inv, signature, msg.sender);
        if (verdict != Verdict.Payable) _refuse(inv, verdict, at, key);

        _receipts[key] = Receipt({payer: msg.sender, paidAt: uint64(block.timestamp)});
        IERC20(inv.token).safeTransferFrom(msg.sender, inv.payTo, inv.amount);
        emit InvoicePaid(key, inv.payeeAgentId, msg.sender, inv.invoiceId, inv.payTo, inv.token, inv.amount, hashInvoice(inv));
    }

    function _check(Invoice calldata inv, bytes calldata signature, address payer)
        private
        view
        returns (Verdict, uint64, bytes32 key)
    {
        key = invoiceKey(inv.payeeAgentId, inv.invoiceId);
        if (inv.amount == 0) return (Verdict.ZeroAmount, 0, key);
        if (inv.dueBy != 0 && block.timestamp > inv.dueBy) return (Verdict.Expired, inv.dueBy, key);
        if (inv.payer != address(0) && inv.payer != payer) return (Verdict.WrongPayer, 0, key);
        uint64 paidAt = _receipts[key].paidAt;
        if (paidAt != 0) return (Verdict.AlreadyPaid, paidAt, key);
        if (!_validSignature(inv.payeeAgentId, hashInvoice(inv), signature)) return (Verdict.BadSignature, 0, key);

        (PayeeRegistry.PayeeStatus status, PayeeRegistry.Payee memory p) = registry.payeeInfo(inv.payeeAgentId, inv.payTo);
        if (status == PayeeRegistry.PayeeStatus.Active) return (Verdict.Payable, p.activeAt, key);
        if (status == PayeeRegistry.PayeeStatus.None) return (Verdict.PayeeNotRegistered, 0, key);
        if (status == PayeeRegistry.PayeeStatus.AwaitingApproval) return (Verdict.PayeeAwaitingApproval, p.activeAt, key);
        if (status == PayeeRegistry.PayeeStatus.CoolingOff) return (Verdict.PayeeInCoolingOff, p.activeAt, key);
        return (Verdict.PayeeRevoked, p.revokedAt, key);
    }

    function _refuse(Invoice calldata inv, Verdict verdict, uint64 at, bytes32 key) private view {
        if (verdict == Verdict.ZeroAmount) revert ZeroAmount();
        if (verdict == Verdict.Expired) revert InvoiceExpired(at);
        if (verdict == Verdict.WrongPayer) revert WrongPayer(inv.payer, msg.sender);
        if (verdict == Verdict.AlreadyPaid) revert InvoiceAlreadyPaid(key, at);
        if (verdict == Verdict.BadSignature) revert InvalidInvoiceSignature();
        // Payee verdicts: let the registry revert with its own typed reason (PayeeInCoolingOff(agentId, payee, activeAt), ...).
        registry.requirePayable(inv.payeeAgentId, inv.payTo);
    }

    /// @dev Accepts an ECDSA signature from the identity owner or its invoice signer, or an ERC-1271 signature from
    /// either when it is a contract. OZ SignatureChecker is not used: from OZ 5.4 it pulls in Bytes.sol, whose MCOPY
    /// does not compile for Shanghai.
    function _validSignature(uint256 agentId, bytes32 digest, bytes calldata signature) private view returns (bool) {
        if (signature.length == 65) {
            (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
            if (err == ECDSA.RecoverError.NoError && registry.isInvoiceSigner(agentId, recovered)) return true;
        }
        address signer = registry.invoiceSignerOf(agentId);
        if (_valid1271(signer, digest, signature)) return true;
        return _valid1271(registry.ownerOf(agentId), digest, signature);
    }

    function _valid1271(address account, bytes32 digest, bytes calldata signature) private view returns (bool) {
        if (account.code.length == 0) return false;
        (bool ok, bytes memory ret) =
            account.staticcall(abi.encodeWithSelector(IERC1271.isValidSignature.selector, digest, signature));
        return ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == IERC1271.isValidSignature.selector;
    }
}
