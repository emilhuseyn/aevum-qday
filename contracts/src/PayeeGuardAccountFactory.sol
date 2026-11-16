// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PayeeGuardAccount} from "./PayeeGuardAccount.sol";
import {InvoicePay} from "./InvoicePay.sol";

/// @notice Counterfactual PayeeGuardAccount deployment (ERC-1967 proxies, CREATE2), usable as UserOperation initCode.
/// @dev Same shape as the eth-infinitism v0.7 SimpleAccountFactory, which QDay's safe-mode bundler accepts unstaked.
contract PayeeGuardAccountFactory {
    PayeeGuardAccount public immutable accountImplementation;

    event AccountCreated(address indexed account, address indexed owner, uint256 salt);

    constructor(IEntryPoint entryPoint_, InvoicePay invoicePay_) {
        accountImplementation = new PayeeGuardAccount(entryPoint_, invoicePay_);
    }

    function createAccount(address owner, uint256 salt) external returns (PayeeGuardAccount account) {
        address addr = getAddress(owner, salt);
        if (addr.code.length > 0) return PayeeGuardAccount(payable(addr));
        account = PayeeGuardAccount(
            payable(
                new ERC1967Proxy{salt: bytes32(salt)}(
                    address(accountImplementation), abi.encodeCall(PayeeGuardAccount.initialize, (owner))
                )
            )
        );
        emit AccountCreated(address(account), owner, salt);
    }

    function getAddress(address owner, uint256 salt) public view returns (address) {
        return Create2.computeAddress(
            bytes32(salt),
            keccak256(
                abi.encodePacked(
                    type(ERC1967Proxy).creationCode,
                    abi.encode(address(accountImplementation), abi.encodeCall(PayeeGuardAccount.initialize, (owner)))
                )
            )
        );
    }
}
