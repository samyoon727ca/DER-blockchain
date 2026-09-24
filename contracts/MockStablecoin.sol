// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockStablecoin
 * @notice Test-only USD stand-in ("mUSD", 6 decimals like USDC). Has no value;
 *         the owner mints balances for simulated participants.
 */
contract MockStablecoin is ERC20, Ownable {
    constructor(address owner_) ERC20("Mock USD", "mUSD") Ownable(owner_) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
