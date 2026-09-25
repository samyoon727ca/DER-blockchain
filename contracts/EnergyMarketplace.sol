// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title EnergyMarketplace
 * @notice Peer-to-peer order book for energy credits (EnergyToken, 1 unit = 1 Wh).
 *
 *  - A prosumer lists credits at a price per kWh; the credits move into escrow
 *    here so the same energy can never be sold twice.
 *  - A consumer buys all or part of a listing with the payment token (a mock
 *    stablecoin). Payment goes straight to the seller; credits go to the buyer.
 *  - Credits are burned when the buyer's meter reports the energy as consumed
 *    (see EnergyToken.submitReading).
 *
 * `buy` takes a `maxPricePerKwh` so a buyer can never be filled at a price
 * the seller raised after the buyer signed (front-running protection).
 *
 * Every function does constant work; open listings are enumerated off-chain
 * from events, never looped over on-chain.
 */
contract EnergyMarketplace is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    uint256 public constant WH_PER_KWH = 1000;

    IERC20 public immutable energyToken;
    IERC20 public immutable paymentToken;

    struct Listing {
        address seller;
        bool active;
        uint256 remainingWh; // credits still in escrow for this listing
        uint256 pricePerKwh; // payment-token base units per kWh
    }

    uint256 public nextListingId = 1;
    mapping(uint256 listingId => Listing) private _listings;

    event ListingCreated(uint256 indexed listingId, address indexed seller, uint256 amountWh, uint256 pricePerKwh);
    event ListingPriceUpdated(uint256 indexed listingId, uint256 oldPricePerKwh, uint256 newPricePerKwh);
    event ListingCancelled(uint256 indexed listingId, address indexed seller, uint256 returnedWh);
    event Trade(
        uint256 indexed listingId,
        address indexed seller,
        address indexed buyer,
        uint256 amountWh,
        uint256 pricePerKwh,
        uint256 cost
    );

    error ZeroAddress();
    error ZeroAmount();
    error ZeroPrice();
    error ListingNotActive(uint256 listingId);
    error NotSeller(uint256 listingId);
    error SelfTrade(uint256 listingId);
    error InsufficientListing(uint256 listingId, uint256 requestedWh, uint256 remainingWh);
    error PriceAboveLimit(uint256 listingId, uint256 pricePerKwh, uint256 maxPricePerKwh);

    constructor(address admin, IERC20 energyToken_, IERC20 paymentToken_) {
        if (admin == address(0) || address(energyToken_) == address(0) || address(paymentToken_) == address(0)) {
            revert ZeroAddress();
        }
        energyToken = energyToken_;
        paymentToken = paymentToken_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    /// @notice Escrow `amountWh` credits and offer them at `pricePerKwh`.
    function createListing(
        uint256 amountWh,
        uint256 pricePerKwh
    ) external whenNotPaused nonReentrant returns (uint256 listingId) {
        if (amountWh == 0) revert ZeroAmount();
        if (pricePerKwh == 0) revert ZeroPrice();

        listingId = nextListingId++;
        _listings[listingId] = Listing({
            seller: msg.sender,
            active: true,
            remainingWh: amountWh,
            pricePerKwh: pricePerKwh
        });
        emit ListingCreated(listingId, msg.sender, amountWh, pricePerKwh);

        energyToken.safeTransferFrom(msg.sender, address(this), amountWh);
    }

    /// @notice Seller re-prices an open listing. Buyers are protected by `maxPricePerKwh` in `buy`.
    function updatePrice(uint256 listingId, uint256 newPricePerKwh) external whenNotPaused {
        Listing storage l = _activeListing(listingId);
        if (l.seller != msg.sender) revert NotSeller(listingId);
        if (newPricePerKwh == 0) revert ZeroPrice();

        emit ListingPriceUpdated(listingId, l.pricePerKwh, newPricePerKwh);
        l.pricePerKwh = newPricePerKwh;
    }

    /// @notice Close a listing and return unsold credits. Allowed while paused so sellers can always exit.
    function cancelListing(uint256 listingId) external nonReentrant {
        Listing storage l = _activeListing(listingId);
        if (l.seller != msg.sender) revert NotSeller(listingId);

        uint256 returnedWh = l.remainingWh;
        l.remainingWh = 0;
        l.active = false;
        emit ListingCancelled(listingId, msg.sender, returnedWh);

        if (returnedWh > 0) energyToken.safeTransfer(msg.sender, returnedWh);
    }

    /**
     * @notice Buy `amountWh` credits from a listing.
     * @param maxPricePerKwh Highest price the buyer accepts; reverts if the listing is now more expensive.
     * @return cost Payment-token amount transferred to the seller (rounded up to the smallest unit).
     */
    function buy(
        uint256 listingId,
        uint256 amountWh,
        uint256 maxPricePerKwh
    ) external whenNotPaused nonReentrant returns (uint256 cost) {
        Listing storage l = _activeListing(listingId);
        if (amountWh == 0) revert ZeroAmount();
        if (l.seller == msg.sender) revert SelfTrade(listingId);
        if (amountWh > l.remainingWh) revert InsufficientListing(listingId, amountWh, l.remainingWh);
        if (l.pricePerKwh > maxPricePerKwh) revert PriceAboveLimit(listingId, l.pricePerKwh, maxPricePerKwh);

        cost = quote(l.pricePerKwh, amountWh);
        address seller = l.seller;

        l.remainingWh -= amountWh;
        if (l.remainingWh == 0) l.active = false;
        emit Trade(listingId, seller, msg.sender, amountWh, l.pricePerKwh, cost);

        paymentToken.safeTransferFrom(msg.sender, seller, cost);
        energyToken.safeTransfer(msg.sender, amountWh);
    }

    /// @notice Price of `amountWh` at `pricePerKwh`, rounded up so dust trades are never free.
    function quote(uint256 pricePerKwh, uint256 amountWh) public pure returns (uint256) {
        return Math.mulDiv(amountWh, pricePerKwh, WH_PER_KWH, Math.Rounding.Ceil);
    }

    function getListing(uint256 listingId) external view returns (Listing memory) {
        return _listings[listingId];
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function _activeListing(uint256 listingId) private view returns (Listing storage l) {
        l = _listings[listingId];
        if (!l.active) revert ListingNotActive(listingId);
    }
}
