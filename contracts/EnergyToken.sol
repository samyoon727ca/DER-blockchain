// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title EnergyToken
 * @notice ERC-20 credit for verified exported energy: 1 token = 1 kWh.
 *         `decimals()` is 3, so one base unit is exactly 1 Wh.
 *
 * Tokens only come into existence through `submitReading`, which the oracle
 * calls with a reading signed by a registered smart meter. The contract
 * re-checks everything the oracle is supposed to have checked (signature,
 * replay, double counting, rated capacity), so a compromised oracle key can
 * delay or censor readings but cannot mint energy that no meter signed for.
 *
 * The same reading also carries the energy the meter imported from the grid.
 * That consumption is paid for with credits first: up to `importedWh` tokens
 * are burned from the meter owner's wallet ("energy consumed").
 *
 * Roles:
 *   DEFAULT_ADMIN_ROLE - grants/revokes the other roles
 *   REGISTRAR_ROLE     - onboards meters (utility / DSO)
 *   ORACLE_ROLE        - submits meter readings (the only path to mint)
 *   PAUSER_ROLE        - emergency stop for mint, burn and transfers
 */
contract EnergyToken is ERC20, ERC20Pausable, AccessControl, EIP712 {
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Settlement interval length; readings cover [intervalStart, intervalStart + 15 min).
    uint64 public constant INTERVAL_SECONDS = 15 minutes;

    bytes32 public constant READING_TYPEHASH =
        keccak256(
            "MeterReading(address meter,uint64 intervalStart,uint32 exportedWh,uint32 importedWh,uint64 nonce)"
        );

    /// @notice A 15-minute interval reading, signed (EIP-712) by the meter's own key.
    struct MeterReading {
        address meter; // meter's signing address; also its id
        uint64 intervalStart; // unix seconds, multiple of INTERVAL_SECONDS
        uint32 exportedWh; // energy delivered to the grid during the interval
        uint32 importedWh; // energy drawn from the grid during the interval
        uint64 nonce; // strictly increasing per meter
    }

    struct Meter {
        address owner; // wallet credited for exports and debited for imports
        uint32 maxExportWh; // rated export capacity per interval (PV/inverter nameplate)
        uint32 maxImportWh; // service-connection limit per interval
        bool active;
        uint64 lastNonce;
        uint64 lastIntervalStart;
    }

    mapping(address meter => Meter) private _meters;

    event MeterRegistered(address indexed meter, address indexed owner, uint32 maxExportWh, uint32 maxImportWh);
    event MeterStatusChanged(address indexed meter, bool active);
    event ReadingSettled(
        address indexed meter,
        address indexed owner,
        uint64 intervalStart,
        uint64 nonce,
        uint32 exportedWh,
        uint32 importedWh
    );
    event CreditsMinted(address indexed owner, address indexed meter, uint64 intervalStart, uint256 amountWh);
    event CreditsBurned(address indexed owner, address indexed meter, uint64 intervalStart, uint256 amountWh);

    error ZeroAddress();
    error MeterAlreadyRegistered(address meter);
    error UnknownMeter(address meter);
    error MeterNotActive(address meter);
    error IntervalNotAligned(uint64 intervalStart);
    error IntervalNotFinished(uint64 intervalStart);
    error IntervalAlreadySettled(address meter, uint64 intervalStart);
    error StaleNonce(address meter, uint64 nonce);
    error ExportAboveCapacity(address meter, uint32 exportedWh, uint32 maxExportWh);
    error ImportAboveCapacity(address meter, uint32 importedWh, uint32 maxImportWh);
    error InvalidMeterSignature(address meter);

    constructor(address admin) ERC20("Verified Energy Credit", "EKWH") EIP712("EnergyToken", "1") {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    /// @dev 1 token = 1 kWh, 1 base unit = 1 Wh.
    function decimals() public pure override returns (uint8) {
        return 3;
    }

    // ---------------------------------------------------------------------
    // Meter registry
    // ---------------------------------------------------------------------

    /**
     * @notice Onboard a meter. A meter address can only be registered once, so
     *         its nonce/interval history can never be reset (which would reopen
     *         old readings to replay).
     */
    function registerMeter(
        address meter,
        address owner,
        uint32 maxExportWh,
        uint32 maxImportWh
    ) external onlyRole(REGISTRAR_ROLE) {
        if (meter == address(0) || owner == address(0)) revert ZeroAddress();
        if (_meters[meter].owner != address(0)) revert MeterAlreadyRegistered(meter);
        _meters[meter] = Meter({
            owner: owner,
            maxExportWh: maxExportWh,
            maxImportWh: maxImportWh,
            active: true,
            lastNonce: 0,
            lastIntervalStart: 0
        });
        emit MeterRegistered(meter, owner, maxExportWh, maxImportWh);
    }

    /// @notice Suspend (e.g. suspected key compromise) or reinstate a meter.
    function setMeterActive(address meter, bool active) external onlyRole(REGISTRAR_ROLE) {
        if (_meters[meter].owner == address(0)) revert UnknownMeter(meter);
        _meters[meter].active = active;
        emit MeterStatusChanged(meter, active);
    }

    function getMeter(address meter) external view returns (Meter memory) {
        return _meters[meter];
    }

    // ---------------------------------------------------------------------
    // Readings: the only way to mint (and the consumption burn)
    // ---------------------------------------------------------------------

    /**
     * @notice Settle one signed meter reading: mint `exportedWh` credits to the
     *         meter owner, then burn up to `importedWh` credits from the owner.
     * @dev Constant work per call; no loops.
     */
    function submitReading(
        MeterReading calldata reading,
        bytes calldata signature
    ) external onlyRole(ORACLE_ROLE) whenNotPaused {
        Meter storage m = _meters[reading.meter];
        if (m.owner == address(0)) revert UnknownMeter(reading.meter);
        if (!m.active) revert MeterNotActive(reading.meter);

        // Time and replay checks. Intervals must be aligned, finished, and
        // strictly newer than the last settled one, so each interval of each
        // meter can be credited at most once (no double counting).
        if (reading.intervalStart % INTERVAL_SECONDS != 0) revert IntervalNotAligned(reading.intervalStart);
        if (uint256(reading.intervalStart) + INTERVAL_SECONDS > block.timestamp) {
            revert IntervalNotFinished(reading.intervalStart);
        }
        if (reading.intervalStart <= m.lastIntervalStart) {
            revert IntervalAlreadySettled(reading.meter, reading.intervalStart);
        }
        if (reading.nonce <= m.lastNonce) revert StaleNonce(reading.meter, reading.nonce);

        // Physical plausibility against the registered ratings.
        if (reading.exportedWh > m.maxExportWh) {
            revert ExportAboveCapacity(reading.meter, reading.exportedWh, m.maxExportWh);
        }
        if (reading.importedWh > m.maxImportWh) {
            revert ImportAboveCapacity(reading.meter, reading.importedWh, m.maxImportWh);
        }

        // The reading must be signed by the meter's own key. The EIP-712 domain
        // binds the signature to this chain and this contract.
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecoverCalldata(_readingDigest(reading), signature);
        if (err != ECDSA.RecoverError.NoError || signer != reading.meter) {
            revert InvalidMeterSignature(reading.meter);
        }

        m.lastNonce = reading.nonce;
        m.lastIntervalStart = reading.intervalStart;
        address owner = m.owner;

        emit ReadingSettled(
            reading.meter,
            owner,
            reading.intervalStart,
            reading.nonce,
            reading.exportedWh,
            reading.importedWh
        );

        if (reading.exportedWh > 0) {
            _mint(owner, reading.exportedWh);
            emit CreditsMinted(owner, reading.meter, reading.intervalStart, reading.exportedWh);
        }

        if (reading.importedWh > 0) {
            uint256 balance = balanceOf(owner);
            uint256 burnWh = balance < reading.importedWh ? balance : reading.importedWh;
            if (burnWh > 0) {
                _burn(owner, burnWh);
                emit CreditsBurned(owner, reading.meter, reading.intervalStart, burnWh);
            }
        }
    }

    /// @notice EIP-712 digest a meter signs for `reading` (exposed for off-chain tooling and tests).
    function readingDigest(MeterReading calldata reading) external view returns (bytes32) {
        return _readingDigest(reading);
    }

    function _readingDigest(MeterReading calldata reading) private view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(
                    abi.encode(
                        READING_TYPEHASH,
                        reading.meter,
                        reading.intervalStart,
                        reading.exportedWh,
                        reading.importedWh,
                        reading.nonce
                    )
                )
            );
    }

    // ---------------------------------------------------------------------
    // Emergency stop
    // ---------------------------------------------------------------------

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @dev Pausing blocks mint, burn and transfers alike.
    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Pausable) {
        super._update(from, to, value);
    }
}
