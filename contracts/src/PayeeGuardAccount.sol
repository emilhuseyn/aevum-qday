// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseAccount} from "account-abstraction/core/BaseAccount.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {_packValidationData, SIG_VALIDATION_FAILED} from "account-abstraction/core/Helpers.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {InvoicePay, Invoice} from "./InvoicePay.sol";

/// @title PayeeGuardAccount
/// @notice ERC-4337 v0.7 smart account for a payer. The owner key has full control. Session keys (an AI assistant,
/// an ops bot) can do exactly one thing: pay a signed invoice through InvoicePay, within a policy that is enforced in
/// validateUserOp, so an out-of-policy UserOperation never reaches execution:
///   token, per-payment cap, daily cap, validity window, optional payee allowlist (ERC-8004 agentIds).
/// The owner grants and revokes sessions in one call; revocation takes effect for the very next UserOperation.
/// @dev Written for ERC-7562 (QDay's bundler runs rundler in safe mode): validation reads and writes only this
/// account's storage and uses no TIMESTAMP/NUMBER. Time limits are returned as validAfter/validUntil: a session
/// signature names a UTC day index, the daily cap is accounted per day, and the EntryPoint enforces that the op lands
/// inside that day and inside the session's validity window.
///
/// Signature formats (userOp.signature):
///   owner:   65-byte ECDSA over toEthSignedMessageHash(userOpHash)
///   session: 0x01 ‖ sessionKey (20) ‖ day (uint32, 4) ‖ 65-byte ECDSA over
///            toEthSignedMessageHash(keccak256(abi.encode(userOpHash, day)))
contract PayeeGuardAccount is BaseAccount, Initializable, UUPSUpgradeable, IERC1271, IERC721Receiver {
    using SafeERC20 for IERC20;

    struct SessionPolicy {
        address token;
        uint128 perPaymentCap;
        uint128 dailyCap;
        uint48 validAfter;
        uint48 validUntil;
        bool restrictPayees;
    }

    struct Session {
        SessionPolicy policy;
        uint64 grantId; // 0 = no active session
    }

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    uint8 public constant SESSION_SIGNATURE_PREFIX = 0x01;
    uint256 public constant SESSION_SIGNATURE_LENGTH = 90;
    uint256 private constant DAY = 1 days;

    IEntryPoint private immutable _entryPoint;
    InvoicePay public immutable invoicePay;

    address public owner;
    uint64 private _grantCounter;
    mapping(address key => Session) private _sessions;
    mapping(uint64 grantId => mapping(uint256 agentId => bool)) private _allowedPayee;
    mapping(address key => mapping(uint32 day => uint256)) private _spent;

    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event SessionGranted(
        address indexed key,
        uint64 indexed grantId,
        address token,
        uint128 perPaymentCap,
        uint128 dailyCap,
        uint48 validAfter,
        uint48 validUntil,
        uint256[] payeeAgentIds
    );
    event SessionRevoked(address indexed key, uint64 indexed grantId);
    event InvoicePaidFromAccount(
        address indexed sessionKey,
        uint256 indexed payeeAgentId,
        bytes32 indexed invoiceId,
        address token,
        uint256 amount,
        bytes32 receiptKey
    );

    error NotOwner(address caller);
    error NotOwnerOrEntryPoint(address caller);
    error InvalidOwner();
    error InvalidSessionPolicy();
    error SessionNotActive(address key);
    error SessionCallNotAllowed(bytes4 selector);
    error SessionKeyMismatch(address signer, address named);
    error SessionTokenNotAllowed(address token);
    error SessionPerPaymentCapExceeded(uint256 amount, uint256 cap);
    error SessionDailyCapExceeded(uint32 day, uint256 spentWithThis, uint256 cap);
    error SessionPayeeNotAllowed(uint256 payeeAgentId);
    error CallFailed(uint256 index, bytes reason);

    modifier onlyOwner() {
        if (msg.sender != owner && msg.sender != address(this)) revert NotOwner(msg.sender);
        _;
    }

    modifier onlyOwnerOrEntryPoint() {
        if (msg.sender != owner && msg.sender != address(_entryPoint) && msg.sender != address(this)) {
            revert NotOwnerOrEntryPoint(msg.sender);
        }
        _;
    }

    constructor(IEntryPoint entryPoint_, InvoicePay invoicePay_) {
        _entryPoint = entryPoint_;
        invoicePay = invoicePay_;
        _disableInitializers();
    }

    function initialize(address owner_) external initializer {
        if (owner_ == address(0)) revert InvalidOwner();
        owner = owner_;
        emit OwnerChanged(address(0), owner_);
    }

    receive() external payable {}

    function entryPoint() public view override returns (IEntryPoint) {
        return _entryPoint;
    }

    // ----------------------------------------------------------------------------------------------------------------
    // Validation
    // ----------------------------------------------------------------------------------------------------------------

    function _validateSignature(PackedUserOperation calldata userOp, bytes32 userOpHash)
        internal
        override
        returns (uint256 validationData)
    {
        bytes calldata signature = userOp.signature;
        if (signature.length == 65) {
            return _recover(MessageHashUtils.toEthSignedMessageHash(userOpHash), signature) == owner
                ? 0
                : SIG_VALIDATION_FAILED;
        }
        if (signature.length == SESSION_SIGNATURE_LENGTH && uint8(signature[0]) == SESSION_SIGNATURE_PREFIX) {
            return _validateSession(userOp, userOpHash);
        }
        return SIG_VALIDATION_FAILED;
    }

    function _validateSession(PackedUserOperation calldata userOp, bytes32 userOpHash) private returns (uint256) {
        bytes calldata signature = userOp.signature;
        address key = address(bytes20(signature[1:21]));
        uint32 day = uint32(bytes4(signature[21:25]));

        Session storage session = _sessions[key];
        if (session.grantId == 0) revert SessionNotActive(key);
        // No early return on a bad signature: bundlers estimate gas with a dummy signature, and the policy path below
        // (including the storage write) must run for the estimate to cover it. A failed signature still fails the op.
        bool sigFailed = _recover(sessionDigest(userOpHash, day), signature[25:90]) != key;
        _enforcePolicy(session, key, day, userOp.callData);
        (uint48 validAfter, uint48 validUntil) = _window(session.policy, day);
        return _packValidationData(sigFailed, validUntil, validAfter);
    }

    /// @notice What a session key signs for a UserOperation on a given UTC day (day = unix time / 86400).
    function sessionDigest(bytes32 userOpHash, uint32 day) public pure returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(keccak256(abi.encode(userOpHash, day)));
    }

    function _enforcePolicy(Session storage session, address key, uint32 day, bytes calldata callData) private {
        (address token, uint256 amount, uint256 payeeAgentId) = _decodeSessionCall(callData, key);
        SessionPolicy storage policy = session.policy;
        if (token != policy.token) revert SessionTokenNotAllowed(token);
        if (amount > policy.perPaymentCap) revert SessionPerPaymentCapExceeded(amount, policy.perPaymentCap);
        if (policy.restrictPayees && !_allowedPayee[session.grantId][payeeAgentId]) {
            revert SessionPayeeNotAllowed(payeeAgentId);
        }
        uint256 spentWithThis = _spent[key][day] + amount;
        if (spentWithThis > policy.dailyCap) revert SessionDailyCapExceeded(day, spentWithThis, policy.dailyCap);
        _spent[key][day] = spentWithThis;
    }

    /// @dev The op must land inside its UTC day and inside the session's validity window (enforced by the EntryPoint).
    function _window(SessionPolicy storage policy, uint32 day)
        private
        view
        returns (uint48 validAfter, uint48 validUntil)
    {
        uint256 dayStart = uint256(day) * DAY;
        uint256 dayEnd = dayStart + DAY - 1;
        validAfter = uint48(dayStart > policy.validAfter ? dayStart : policy.validAfter);
        validUntil = uint48(dayEnd < policy.validUntil ? dayEnd : policy.validUntil);
    }

    /// @dev A session may only call this.payInvoice(invoice, invoiceSignature, sessionKey) naming itself.
    function _decodeSessionCall(bytes calldata callData, address key)
        private
        pure
        returns (address token, uint256 amount, uint256 payeeAgentId)
    {
        bytes4 selector = callData.length >= 4 ? bytes4(callData[0:4]) : bytes4(0);
        if (selector != this.payInvoice.selector) revert SessionCallNotAllowed(selector);
        (Invoice memory inv,, address named) = abi.decode(callData[4:], (Invoice, bytes, address));
        if (named != key) revert SessionKeyMismatch(key, named);
        return (inv.token, inv.amount, inv.payeeAgentId);
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        return err == ECDSA.RecoverError.NoError ? recovered : address(0);
    }

    // ----------------------------------------------------------------------------------------------------------------
    // Execution
    // ----------------------------------------------------------------------------------------------------------------

    /// @notice Pays a signed invoice through InvoicePay. Approves exactly the invoice amount for this one call, so the
    /// account never leaves a standing allowance. `sessionKey` is the session that authorised it (0 for the owner).
    function payInvoice(Invoice calldata inv, bytes calldata invoiceSignature, address sessionKey)
        external
        onlyOwnerOrEntryPoint
        returns (bytes32 receiptKey)
    {
        IERC20(inv.token).forceApprove(address(invoicePay), inv.amount);
        receiptKey = invoicePay.payInvoice(inv, invoiceSignature);
        emit InvoicePaidFromAccount(sessionKey, inv.payeeAgentId, inv.invoiceId, inv.token, inv.amount, receiptKey);
    }

    function execute(address target, uint256 value, bytes calldata data) external onlyOwnerOrEntryPoint {
        _call(0, target, value, data);
    }

    function executeBatch(Call[] calldata calls) external onlyOwnerOrEntryPoint {
        for (uint256 i; i < calls.length; ++i) {
            _call(i, calls[i].target, calls[i].value, calls[i].data);
        }
    }

    function _call(uint256 index, address target, uint256 value, bytes calldata data) private {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert CallFailed(index, ret);
    }

    // ----------------------------------------------------------------------------------------------------------------
    // Sessions (owner only: a session UserOperation can only reach payInvoice)
    // ----------------------------------------------------------------------------------------------------------------

    function grantSession(address key, SessionPolicy calldata policy, uint256[] calldata payeeAgentIds)
        external
        onlyOwnerOrEntryPoint
        returns (uint64 grantId)
    {
        if (
            key == address(0) || key == owner || policy.token == address(0) || policy.perPaymentCap == 0
                || policy.dailyCap < policy.perPaymentCap || policy.validUntil <= policy.validAfter
                || (policy.restrictPayees && payeeAgentIds.length == 0)
        ) revert InvalidSessionPolicy();
        grantId = ++_grantCounter;
        _sessions[key] = Session({policy: policy, grantId: grantId});
        for (uint256 i; i < payeeAgentIds.length; ++i) {
            _allowedPayee[grantId][payeeAgentIds[i]] = true;
        }
        emit SessionGranted(
            key,
            grantId,
            policy.token,
            policy.perPaymentCap,
            policy.dailyCap,
            policy.validAfter,
            policy.validUntil,
            payeeAgentIds
        );
    }

    /// @notice Instant revocation: the next UserOperation signed by `key` fails validation with SessionNotActive.
    function revokeSession(address key) external onlyOwnerOrEntryPoint {
        uint64 grantId = _sessions[key].grantId;
        if (grantId == 0) revert SessionNotActive(key);
        delete _sessions[key];
        emit SessionRevoked(key, grantId);
    }

    function sessionOf(address key) external view returns (Session memory) {
        return _sessions[key];
    }

    function spentOn(address key, uint32 day) external view returns (uint256) {
        return _spent[key][day];
    }

    function isPayeeAllowed(address key, uint256 payeeAgentId) external view returns (bool) {
        Session storage session = _sessions[key];
        if (session.grantId == 0) return false;
        return !session.policy.restrictPayees || _allowedPayee[session.grantId][payeeAgentId];
    }

    // ----------------------------------------------------------------------------------------------------------------
    // Owner administration
    // ----------------------------------------------------------------------------------------------------------------

    function transferOwnership(address newOwner) external onlyOwnerOrEntryPoint {
        if (newOwner == address(0)) revert InvalidOwner();
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    function addDeposit() external payable {
        _entryPoint.depositTo{value: msg.value}(address(this));
    }

    function withdrawDepositTo(address payable to, uint256 amount) external onlyOwnerOrEntryPoint {
        _entryPoint.withdrawTo(to, amount);
    }

    function _authorizeUpgrade(address) internal view override onlyOwner {}

    // ----------------------------------------------------------------------------------------------------------------
    // Signatures and tokens
    // ----------------------------------------------------------------------------------------------------------------

    /// @notice ERC-1271: valid if the owner signed `hash` (lets the account own an ERC-8004 identity and sign invoices).
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return signature.length == 65 && _recover(hash, signature) == owner ? this.isValidSignature.selector : bytes4(0);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
