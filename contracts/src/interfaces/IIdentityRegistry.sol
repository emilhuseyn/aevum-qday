// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The part of the ERC-8004 IdentityRegistry (an ERC-721) that PayeeGuard relies on.
interface IIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
}
