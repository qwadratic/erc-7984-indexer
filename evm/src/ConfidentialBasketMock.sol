// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {FHE, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";

/**
 * @title ConfidentialBasketMock — big-structure confidential token (boundary instrument)
 *
 * A holder's position is a K-slot vector, not a single balance. One `basketTransfer`
 * fans out into K `ConfidentialTransfer` events — K bytes32 handles per transfer, i.e.
 * K× the crypto-bytes a plain ERC-7984 transfer emits. `SLOTS` (K) is the knob that
 * inflates handles/transfer to push the off-chain decrypt worker past its service rate.
 * That saturation point is the boundary the indexer must survive.
 *
 * Structure of the K handles per transfer:
 *   - slot 0           = the live, entropy-bearing amount (moves balance; UNIQUE handle each call)
 *   - slots 1..K-1     = a single shared structural `_template` handle (IDENTICAL bytes32 every call)
 *
 * The structural slots reuse one ciphertext on purpose: it makes the inflation
 * *indexable*. A distinct-handle index in the worker collapses all K-1 repeats to a
 * single decrypt — so indexing the generated crypto-bytes compensates the inflation,
 * and the boundary stops depending on K. Reuses the inherited `ConfidentialTransfer`
 * event so the existing indexer + ABI pick up the extra handles with no change.
 *
 * Mock only — `basketTransfer` moves real balance for slot 0; the structural slots are
 * pure handle emission (no per-slot bookkeeping). Not a production token.
 */
contract ConfidentialBasketMock is ERC7984, ZamaEthereumConfig {
    /// @dev K — handles emitted per basketTransfer (1 live + SLOTS-1 structural).
    uint256 public immutable SLOTS;

    /// @dev Shared structural ciphertext reused by every structural slot of every transfer.
    euint64 private _template;

    constructor(string memory name_, string memory symbol_, uint256 slots_) ERC7984(name_, symbol_, "") {
        require(slots_ >= 1, "slots>=1");
        SLOTS = slots_;
        _template = FHE.asEuint64(0); // deterministic structural ciphertext (decrypt-once, ever)
        FHE.allowThis(_template);
    }

    /// @dev Mint a starting position (cleartext amount for test convenience). Slot-0 balance only.
    function mintBasket(address to, uint64 liveAmount) external {
        _mint(to, FHE.asEuint64(liveAmount));
    }

    /**
     * @dev One logical transfer → K `ConfidentialTransfer` logs.
     *      slot 0 moves balance and emits a unique handle; slots 1..K-1 re-emit the
     *      shared structural handle. Both parties are granted ACL access to the template
     *      so a delegate can decrypt it (once) like any other handle.
     */
    function basketTransfer(address to, externalEuint64 amount, bytes calldata proof) external {
        euint64 live = FHE.fromExternal(amount, proof);
        _transfer(msg.sender, to, live); // emits ConfidentialTransfer(from, to, <unique handle>)

        // Structural fan-out: K-1 identical handles. Grant access once so it stays decryptable.
        FHE.allow(_template, msg.sender);
        FHE.allow(_template, to);
        for (uint256 i = 1; i < SLOTS; i++) {
            emit ConfidentialTransfer(msg.sender, to, _template);
        }
    }
}
