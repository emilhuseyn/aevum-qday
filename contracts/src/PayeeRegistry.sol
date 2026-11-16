// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/// @title PayeeRegistry
/// @notice Binds payout addresses to an ERC-8004 identity. A new or changed payout address is not payable until a
/// cooling-off has passed (and, if the business set a guardian, until the guardian approved it), so a stolen
/// invoicing or owner key cannot redirect money faster than the business can notice and cancel.
/// @dev All state is scoped to (agentId, current identity owner). When the identity NFT changes hands, the new owner
/// starts with no payout addresses, the default policy and no invoice signer; this mirrors ERC-8004 clearing
/// agentWallet on transfer.
contract PayeeRegistry {
    enum PayeeStatus {
        None,
        AwaitingApproval,
        CoolingOff,
        Active,
        Revoked
    }

    struct Payee {
        uint64 requestedAt;
        uint64 activeAt;
        uint64 revokedAt;
        bool approved;
        bool announced;
    }

    struct Policy {
        uint32 coolingOff; // 0 means defaultCoolingOff
        address guardian; // optional second key: approves new payees and policy changes, can cancel and revoke
    }

    struct PendingPolicy {
        uint32 coolingOff;
        address guardian;
        uint64 effectiveAt; // 0 means nothing pending
    }

    uint32 public constant MAX_COOLING_OFF = 30 days;

    IIdentityRegistry public immutable identity;
    uint32 public immutable minCoolingOff;
    uint32 public immutable defaultCoolingOff;

    mapping(bytes32 scope => mapping(address payee => Payee)) private _payees;
    mapping(bytes32 scope => mapping(address payee => bool)) private _listed;
    mapping(bytes32 scope => address[]) private _payeeList;
    mapping(bytes32 scope => Policy) private _policies;
    mapping(bytes32 scope => PendingPolicy) private _pendingPolicies;
    mapping(bytes32 scope => address) private _invoiceSigners;

    event PayeeChangeRequested(
        uint256 indexed agentId, address indexed payee, address indexed requestedBy, uint64 activeAt, bool needsApproval
    );
    event PayeeChangeApproved(uint256 indexed agentId, address indexed payee, address indexed guardian, uint64 activeAt);
    event PayeeChangeCancelled(uint256 indexed agentId, address indexed payee, address indexed cancelledBy);
    event PayeeChangeActivated(uint256 indexed agentId, address indexed payee, uint64 activeAt);
    event PayeeRevoked(uint256 indexed agentId, address indexed payee, address indexed revokedBy);
    event InvoiceSignerSet(uint256 indexed agentId, address indexed signer);
    event PolicyChangeProposed(uint256 indexed agentId, uint32 coolingOff, address guardian, uint64 effectiveAt);
    event PolicyChanged(uint256 indexed agentId, uint32 coolingOff, address guardian);
    event PolicyChangeCancelled(uint256 indexed agentId, address indexed cancelledBy);

    error NotIdentityOwner(uint256 agentId, address caller);
    error NotGuardian(uint256 agentId, address caller);
    error NotOwnerOrGuardian(uint256 agentId, address caller);
    error InvalidPayee();
    error InvalidGuardian();
    error InvalidCoolingOff(uint32 coolingOff);
    error PayeeAlreadyListed(uint256 agentId, address payee, PayeeStatus status);
    error PayeeNotRegistered(uint256 agentId, address payee);
    error PayeeAwaitingApproval(uint256 agentId, address payee, uint64 activeAt);
    error PayeeInCoolingOff(uint256 agentId, address payee, uint64 activeAt);
    error PayeeWasRevoked(uint256 agentId, address payee, uint64 revokedAt);
    error PayeeNotPending(uint256 agentId, address payee, PayeeStatus status);
    error PayeeNotActive(uint256 agentId, address payee, PayeeStatus status);
    error ActivationAlreadyAnnounced(uint256 agentId, address payee);
    error NoPendingPolicy(uint256 agentId);
    error PolicyNotYetEffective(uint256 agentId, uint64 effectiveAt);

    constructor(IIdentityRegistry identity_, uint32 minCoolingOff_, uint32 defaultCoolingOff_) {
        if (minCoolingOff_ == 0 || defaultCoolingOff_ < minCoolingOff_ || defaultCoolingOff_ > MAX_COOLING_OFF) {
            revert InvalidCoolingOff(defaultCoolingOff_);
        }
        identity = identity_;
        minCoolingOff = minCoolingOff_;
        defaultCoolingOff = defaultCoolingOff_;
    }

    // ----------------------------------------------------------------------------------------------------------------
    // Payout addresses
    // ----------------------------------------------------------------------------------------------------------------

    /// @notice Owner adds a payout address. It becomes payable after the cooling-off (and guardian approval, if set).
    function requestPayee(uint256 agentId, address payee) external returns (uint64 activeAt) {
        bytes32 scope = _ownerScope(agentId);
        if (payee == address(0)) revert InvalidPayee();
        Payee storage p = _payees[scope][payee];
        PayeeStatus status = _status(p);
        if (status != PayeeStatus.None && status != PayeeStatus.Revoked) {
            revert PayeeAlreadyListed(agentId, payee, status);
        }
        Policy memory policy = _policies[scope];
        activeAt = uint64(block.timestamp) + _coolingOffOf(policy);
        bool needsApproval = policy.guardian != address(0);
        _payees[scope][payee] = Payee({
            requestedAt: uint64(block.timestamp),
            activeAt: activeAt,
            revokedAt: 0,
            approved: !needsApproval,
            announced: false
        });
        if (!_listed[scope][payee]) {
            _listed[scope][payee] = true;
            _payeeList[scope].push(payee);
        }
        emit PayeeChangeRequested(agentId, payee, msg.sender, activeAt, needsApproval);
    }

    /// @notice Guardian approves a requested payout address. The cooling-off still applies.
    function approvePayee(uint256 agentId, address payee) external {
        bytes32 scope = _scope(agentId);
        if (msg.sender != _policies[scope].guardian || msg.sender == address(0)) revert NotGuardian(agentId, msg.sender);
        Payee storage p = _payees[scope][payee];
        PayeeStatus status = _status(p);
        if (status != PayeeStatus.AwaitingApproval) revert PayeeNotPending(agentId, payee, status);
        p.approved = true;
        emit PayeeChangeApproved(agentId, payee, msg.sender, p.activeAt);
    }

    /// @notice Owner or guardian cancels a payout address that is still awaiting approval or cooling off.
    function cancelPayee(uint256 agentId, address payee) external {
        bytes32 scope = _ownerOrGuardianScope(agentId);
        PayeeStatus status = _status(_payees[scope][payee]);
        if (status != PayeeStatus.AwaitingApproval && status != PayeeStatus.CoolingOff) {
            revert PayeeNotPending(agentId, payee, status);
        }
        delete _payees[scope][payee];
        emit PayeeChangeCancelled(agentId, payee, msg.sender);
    }

    /// @notice Owner or guardian revokes an active payout address. Takes effect immediately.
    function revokePayee(uint256 agentId, address payee) external {
        bytes32 scope = _ownerOrGuardianScope(agentId);
        Payee storage p = _payees[scope][payee];
        PayeeStatus status = _status(p);
        if (status != PayeeStatus.Active) revert PayeeNotActive(agentId, payee, status);
        p.revokedAt = uint64(block.timestamp);
        emit PayeeRevoked(agentId, payee, msg.sender);
    }

    /// @notice Anyone may emit PayeeChangeActivated once a payout address is active, for indexers and alerting.
    /// @dev Payability never depends on this call; it is a log-only poke.
    function announceActivation(uint256 agentId, address payee) external {
        bytes32 scope = _scope(agentId);
        Payee storage p = _payees[scope][payee];
        PayeeStatus status = _status(p);
        if (status != PayeeStatus.Active) revert PayeeNotActive(agentId, payee, status);
        if (p.announced) revert ActivationAlreadyAnnounced(agentId, payee);
        p.announced = true;
        emit PayeeChangeActivated(agentId, payee, p.activeAt);
    }

    // ----------------------------------------------------------------------------------------------------------------
    // Invoice signer (a hot key; it cannot add payout addresses, so its theft cannot redirect money)
    // ----------------------------------------------------------------------------------------------------------------

    function setInvoiceSigner(uint256 agentId, address signer) external {
        _invoiceSigners[_ownerScope(agentId)] = signer;
        emit InvoiceSignerSet(agentId, signer);
    }

    // ----------------------------------------------------------------------------------------------------------------
    // Policy: cooling-off length and guardian. Strengthening applies at once; weakening waits for the current
    // cooling-off (or the guardian's approval) and can be cancelled meanwhile.
    // ----------------------------------------------------------------------------------------------------------------

    function proposePolicy(uint256 agentId, uint32 coolingOff, address guardian) external returns (bool applied) {
        bytes32 scope = _ownerScope(agentId);
        if (coolingOff < minCoolingOff || coolingOff > MAX_COOLING_OFF) revert InvalidCoolingOff(coolingOff);
        if (guardian == msg.sender) revert InvalidGuardian();
        Policy memory current = _policies[scope];
        uint32 currentCoolingOff = _coolingOffOf(current);
        bool strengthens =
            coolingOff >= currentCoolingOff && (current.guardian == address(0) || guardian == current.guardian);
        if (strengthens) {
            _applyPolicy(agentId, scope, coolingOff, guardian);
            return true;
        }
        uint64 effectiveAt = uint64(block.timestamp) + currentCoolingOff;
        _pendingPolicies[scope] = PendingPolicy({coolingOff: coolingOff, guardian: guardian, effectiveAt: effectiveAt});
        emit PolicyChangeProposed(agentId, coolingOff, guardian, effectiveAt);
        return false;
    }

    /// @notice Guardian approves a pending policy change; it applies at once.
    function approvePolicy(uint256 agentId) external {
        bytes32 scope = _scope(agentId);
        if (msg.sender != _policies[scope].guardian || msg.sender == address(0)) revert NotGuardian(agentId, msg.sender);
        PendingPolicy memory pending = _pendingPolicies[scope];
        if (pending.effectiveAt == 0) revert NoPendingPolicy(agentId);
        _applyPolicy(agentId, scope, pending.coolingOff, pending.guardian);
    }

    /// @notice Anyone applies a pending policy change after its waiting period.
    function applyPolicy(uint256 agentId) external {
        bytes32 scope = _scope(agentId);
        PendingPolicy memory pending = _pendingPolicies[scope];
        if (pending.effectiveAt == 0) revert NoPendingPolicy(agentId);
        if (block.timestamp < pending.effectiveAt) revert PolicyNotYetEffective(agentId, pending.effectiveAt);
        _applyPolicy(agentId, scope, pending.coolingOff, pending.guardian);
    }

    function cancelPolicy(uint256 agentId) external {
        bytes32 scope = _ownerOrGuardianScope(agentId);
        if (_pendingPolicies[scope].effectiveAt == 0) revert NoPendingPolicy(agentId);
        delete _pendingPolicies[scope];
        emit PolicyChangeCancelled(agentId, msg.sender);
    }

    // ----------------------------------------------------------------------------------------------------------------
    // Views
    // ----------------------------------------------------------------------------------------------------------------

    /// @notice Reverts with the reason a payout address is not payable; returns normally if it is.
    function requirePayable(uint256 agentId, address payee) external view {
        Payee memory p = _payees[_scope(agentId)][payee];
        PayeeStatus status = _status(p);
        if (status == PayeeStatus.Active) return;
        if (status == PayeeStatus.None) revert PayeeNotRegistered(agentId, payee);
        if (status == PayeeStatus.AwaitingApproval) revert PayeeAwaitingApproval(agentId, payee, p.activeAt);
        if (status == PayeeStatus.CoolingOff) revert PayeeInCoolingOff(agentId, payee, p.activeAt);
        revert PayeeWasRevoked(agentId, payee, p.revokedAt);
    }

    function isPayable(uint256 agentId, address payee) external view returns (bool) {
        return _status(_payees[_scope(agentId)][payee]) == PayeeStatus.Active;
    }

    function payeeInfo(uint256 agentId, address payee) external view returns (PayeeStatus status, Payee memory info) {
        info = _payees[_scope(agentId)][payee];
        status = _status(info);
    }

    function payeesOf(uint256 agentId) external view returns (address[] memory) {
        return _payeeList[_scope(agentId)];
    }

    function policyOf(uint256 agentId)
        external
        view
        returns (uint32 coolingOff, address guardian, PendingPolicy memory pending)
    {
        bytes32 scope = _scope(agentId);
        Policy memory policy = _policies[scope];
        return (_coolingOffOf(policy), policy.guardian, _pendingPolicies[scope]);
    }

    function invoiceSignerOf(uint256 agentId) external view returns (address) {
        return _invoiceSigners[_scope(agentId)];
    }

    /// @notice True for the identity's current owner and for its invoice signer (if set).
    function isInvoiceSigner(uint256 agentId, address account) external view returns (bool) {
        if (account == address(0)) return false;
        address owner = _ownerOf(agentId);
        if (owner == address(0)) return false;
        return account == owner || account == _invoiceSigners[_scopeFor(agentId, owner)];
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        return _ownerOf(agentId);
    }

    // ----------------------------------------------------------------------------------------------------------------
    // Internals
    // ----------------------------------------------------------------------------------------------------------------

    function _status(Payee memory p) private view returns (PayeeStatus) {
        if (p.requestedAt == 0) return PayeeStatus.None;
        if (p.revokedAt != 0) return PayeeStatus.Revoked;
        if (!p.approved) return PayeeStatus.AwaitingApproval;
        if (block.timestamp < p.activeAt) return PayeeStatus.CoolingOff;
        return PayeeStatus.Active;
    }

    function _coolingOffOf(Policy memory policy) private view returns (uint32) {
        return policy.coolingOff == 0 ? defaultCoolingOff : policy.coolingOff;
    }

    function _applyPolicy(uint256 agentId, bytes32 scope, uint32 coolingOff, address guardian) private {
        _policies[scope] = Policy({coolingOff: coolingOff, guardian: guardian});
        delete _pendingPolicies[scope];
        emit PolicyChanged(agentId, coolingOff, guardian);
    }

    function _ownerOf(uint256 agentId) private view returns (address owner) {
        try identity.ownerOf(agentId) returns (address o) {
            owner = o;
        } catch {
            owner = address(0);
        }
    }

    function _scopeFor(uint256 agentId, address owner) private pure returns (bytes32) {
        return keccak256(abi.encode(agentId, owner));
    }

    function _scope(uint256 agentId) private view returns (bytes32) {
        return _scopeFor(agentId, _ownerOf(agentId));
    }

    function _ownerScope(uint256 agentId) private view returns (bytes32) {
        address owner = _ownerOf(agentId);
        if (owner == address(0) || msg.sender != owner) revert NotIdentityOwner(agentId, msg.sender);
        return _scopeFor(agentId, owner);
    }

    function _ownerOrGuardianScope(uint256 agentId) private view returns (bytes32 scope) {
        address owner = _ownerOf(agentId);
        if (owner == address(0)) revert NotOwnerOrGuardian(agentId, msg.sender);
        scope = _scopeFor(agentId, owner);
        address guardian = _policies[scope].guardian;
        if (msg.sender != owner && (guardian == address(0) || msg.sender != guardian)) {
            revert NotOwnerOrGuardian(agentId, msg.sender);
        }
    }
}
