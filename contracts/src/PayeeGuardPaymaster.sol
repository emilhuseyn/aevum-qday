// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BasePaymaster} from "account-abstraction/core/BasePaymaster.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title PayeeGuardPaymaster
/// @notice ERC-4337 v0.7 paymaster that charges gas in a stablecoin (tUSD8 on Aevum). Accounts hold prepaid tUSD8
/// credit here; the paymaster pays the EntryPoint in tQDAY from its deposit. A payer account never needs tQDAY.
/// @dev Validation reserves the worst-case token cost from the sender's credit and postOp refunds the difference, so
/// concurrent operations cannot overspend. Validation touches only this contract's storage and makes no external calls,
/// which ERC-7562 allows for a staked paymaster (QDay's bundler: stake >= 0.1 tQDAY). The rate is set by the owner:
/// tQDAY has no market price on testnet; a mainnet version would read an oracle. EntryPoint v0.7 adds a 10 % penalty
/// on unused execution gas after postOp, which postOp cannot see; the markup covers it when clients use bundler
/// gas estimates (tested), and grossly over-provisioned limits cost the paymaster, not the user.
contract PayeeGuardPaymaster is BasePaymaster {
    using SafeERC20 for IERC20;

    /// @notice Gas charged on top of actualGasCost for the postOp itself.
    uint256 public constant POST_OP_OVERHEAD = 45_000;
    uint16 public constant MAX_MARKUP_BPS = 20_000;

    IERC20 public immutable token;
    /// @notice Token base units charged per 1e18 wei of gas (1e6 = 1 tUSD8 per tQDAY).
    uint256 public tokenPerNative;
    /// @notice 10_000 = cost price.
    uint16 public markupBps;
    /// @notice Fees earned by the paymaster (owner-withdrawable); never mixed with accounts' credit.
    uint256 public collected;

    mapping(address account => uint256) public credit;

    event CreditDeposited(address indexed account, address indexed from, uint256 amount);
    event CreditWithdrawn(address indexed account, address indexed to, uint256 amount);
    event GasPaidInToken(address indexed account, uint256 tokenCost, uint256 gasCostWei);
    event RateSet(uint256 tokenPerNative, uint16 markupBps);
    event FeesWithdrawn(address indexed to, uint256 amount);

    error InsufficientCredit(address account, uint256 required, uint256 available);
    error InvalidRate();
    error AmountTooHigh(uint256 requested, uint256 available);

    constructor(IEntryPoint entryPoint_, IERC20 token_, uint256 tokenPerNative_, uint16 markupBps_)
        BasePaymaster(entryPoint_)
    {
        token = token_;
        _setRate(tokenPerNative_, markupBps_);
    }

    // ----------------------------------------------------------------------------------------------------------------
    // Credit
    // ----------------------------------------------------------------------------------------------------------------

    /// @notice Anyone (an on-ramp, the business, the owner) can prepay gas credit for an account.
    function depositFor(address account, uint256 amount) external {
        token.safeTransferFrom(msg.sender, address(this), amount);
        credit[account] += amount;
        emit CreditDeposited(account, msg.sender, amount);
    }

    /// @notice An account takes back unused credit.
    function withdrawCredit(address to, uint256 amount) external {
        uint256 available = credit[msg.sender];
        if (amount > available) revert AmountTooHigh(amount, available);
        credit[msg.sender] = available - amount;
        token.safeTransfer(to, amount);
        emit CreditWithdrawn(msg.sender, to, amount);
    }

    /// @notice Token cost of `gasCostWei` at the current rate and markup, rounded up.
    function quote(uint256 gasCostWei) public view returns (uint256) {
        return Math.mulDiv(gasCostWei, tokenPerNative * markupBps, 1e18 * 10_000, Math.Rounding.Ceil);
    }

    // ----------------------------------------------------------------------------------------------------------------
    // ERC-4337
    // ----------------------------------------------------------------------------------------------------------------

    function _validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256 maxCost)
        internal
        override
        returns (bytes memory context, uint256 validationData)
    {
        address sender = userOp.sender;
        uint256 reserved = quote(maxCost);
        uint256 available = credit[sender];
        if (available < reserved) revert InsufficientCredit(sender, reserved, available);
        credit[sender] = available - reserved;
        return (abi.encode(sender, reserved), 0);
    }

    function _postOp(PostOpMode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFeePerGas)
        internal
        override
    {
        (address sender, uint256 reserved) = abi.decode(context, (address, uint256));
        uint256 cost = quote(actualGasCost + POST_OP_OVERHEAD * actualUserOpFeePerGas);
        if (cost > reserved) cost = reserved;
        credit[sender] += reserved - cost;
        collected += cost;
        emit GasPaidInToken(sender, cost, actualGasCost);
    }

    // ----------------------------------------------------------------------------------------------------------------
    // Owner
    // ----------------------------------------------------------------------------------------------------------------

    function setRate(uint256 tokenPerNative_, uint16 markupBps_) external onlyOwner {
        _setRate(tokenPerNative_, markupBps_);
    }

    function withdrawFees(address to, uint256 amount) external onlyOwner {
        if (amount > collected) revert AmountTooHigh(amount, collected);
        collected -= amount;
        token.safeTransfer(to, amount);
        emit FeesWithdrawn(to, amount);
    }

    function _setRate(uint256 tokenPerNative_, uint16 markupBps_) private {
        if (tokenPerNative_ == 0 || markupBps_ < 10_000 || markupBps_ > MAX_MARKUP_BPS) revert InvalidRate();
        tokenPerNative = tokenPerNative_;
        markupBps = markupBps_;
        emit RateSet(tokenPerNative_, markupBps_);
    }
}
