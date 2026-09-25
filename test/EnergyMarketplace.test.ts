import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { EnergyMarketplace__factory, EnergyToken__factory, MockStablecoin__factory } from "../typechain-types";
import { INTERVAL_SECONDS } from "../src/shared/reading";
import { USD, quote, usdPerKwh } from "../src/shared/units";
import { MAX_EXPORT_WH, MAX_IMPORT_WH, TestMeter, domainFor, lastFinishedInterval } from "./helpers";

const PRICE = usdPerKwh(0.14); // 140_000 mUSD base units per kWh

describe("EnergyMarketplace", () => {
  async function deployFixture() {
    const [admin, oracle, seller, buyer, other] = await ethers.getSigners();
    const stable = await new MockStablecoin__factory(admin).deploy(admin.address);
    const token = await new EnergyToken__factory(admin).deploy(admin.address);
    const market = await new EnergyMarketplace__factory(admin).deploy(
      admin.address,
      await token.getAddress(),
      await stable.getAddress(),
    );
    await token.grantRole(await token.ORACLE_ROLE(), oracle.address);

    const domain = await domainFor(token);
    const sellerMeter = new TestMeter(domain);
    const buyerMeter = new TestMeter(domain);
    await token.registerMeter(sellerMeter.address, seller.address, MAX_EXPORT_WH, MAX_IMPORT_WH);
    await token.registerMeter(buyerMeter.address, buyer.address, 0, MAX_IMPORT_WH);

    // The seller earns 2.4 kWh of credits from two verified export readings.
    const t0 = await lastFinishedInterval();
    for (const [i, wh] of [[1, 1200], [0, 1200]]) {
      const r = await sellerMeter.sign({ intervalStart: t0 - i * INTERVAL_SECONDS, exportedWh: wh });
      await token.connect(oracle).submitReading(r.reading, r.signature);
    }

    await stable.mint(buyer.address, 10n * USD);
    await stable.mint(other.address, 10n * USD);
    await token.connect(seller).approve(await market.getAddress(), ethers.MaxUint256);
    await stable.connect(buyer).approve(await market.getAddress(), ethers.MaxUint256);
    await stable.connect(other).approve(await market.getAddress(), ethers.MaxUint256);

    return { admin, oracle, seller, buyer, other, token, stable, market, buyerMeter, sellerMeter, t0 };
  }

  async function listedFixture() {
    const f = await deployFixture();
    await f.market.connect(f.seller).createListing(2000, PRICE); // listing #1: 2 kWh @ $0.14
    return { ...f, listingId: 1n };
  }

  describe("listing", () => {
    it("escrows the seller's credits and emits ListingCreated", async () => {
      const { market, token, seller } = await loadFixture(deployFixture);
      const marketAddress = await market.getAddress();

      const tx = await market.connect(seller).createListing(2000, PRICE);
      await expect(tx).to.emit(market, "ListingCreated").withArgs(1, seller.address, 2000, PRICE);
      await expect(tx).to.changeTokenBalances(token, [seller, marketAddress], [-2000, 2000]);

      const l = await market.getListing(1);
      expect(l.seller).to.equal(seller.address);
      expect(l.active).to.be.true;
      expect(l.remainingWh).to.equal(2000);
      expect(l.pricePerKwh).to.equal(PRICE);
      expect(await market.nextListingId()).to.equal(2);
    });

    it("rejects zero amounts and zero prices", async () => {
      const { market, seller } = await loadFixture(deployFixture);
      await expect(market.connect(seller).createListing(0, PRICE)).to.be.revertedWithCustomError(market, "ZeroAmount");
      await expect(market.connect(seller).createListing(100, 0)).to.be.revertedWithCustomError(market, "ZeroPrice");
    });

    it("cannot list more credits than the seller holds (no double selling)", async () => {
      const { market, token, seller } = await loadFixture(deployFixture);
      await market.connect(seller).createListing(2400, PRICE);
      await expect(market.connect(seller).createListing(1, PRICE)).to.be.revertedWithCustomError(
        token,
        "ERC20InsufficientBalance",
      );
    });

    it("requires the seller's approval", async () => {
      const { market, token, buyer, seller } = await loadFixture(deployFixture);
      await token.connect(seller).transfer(buyer.address, 500);
      await expect(market.connect(buyer).createListing(500, PRICE)).to.be.revertedWithCustomError(
        token,
        "ERC20InsufficientAllowance",
      );
    });
  });

  describe("trading", () => {
    it("fills a whole listing: stablecoin to seller, credits to buyer", async () => {
      const { market, token, stable, seller, buyer, listingId } = await loadFixture(listedFixture);
      const cost = quote(PRICE, 2000n); // 2 kWh * $0.14 = $0.28
      expect(cost).to.equal(280_000n);

      const tx = await market.connect(buyer).buy(listingId, 2000, PRICE);
      await expect(tx).to.emit(market, "Trade").withArgs(listingId, seller.address, buyer.address, 2000, PRICE, cost);
      await expect(tx).to.changeTokenBalances(stable, [buyer, seller], [-cost, cost]);

      expect(await token.balanceOf(buyer.address)).to.equal(2000);
      const l = await market.getListing(listingId);
      expect(l.remainingWh).to.equal(0);
      expect(l.active).to.be.false;
    });

    it("supports partial fills", async () => {
      const { market, token, buyer, other, listingId } = await loadFixture(listedFixture);
      await market.connect(buyer).buy(listingId, 500, PRICE);
      await market.connect(other).buy(listingId, 700, PRICE);
      expect(await token.balanceOf(buyer.address)).to.equal(500);
      expect(await token.balanceOf(other.address)).to.equal(700);
      const l = await market.getListing(listingId);
      expect(l.remainingWh).to.equal(800);
      expect(l.active).to.be.true;
    });

    it("rounds the cost up so tiny purchases are never free", async () => {
      const { market, seller, buyer, stable } = await loadFixture(deployFixture);
      const oddPrice = 123_456n; // $0.123456 per kWh
      await market.connect(seller).createListing(10, oddPrice);
      expect(await market.quote(oddPrice, 1)).to.equal(124n); // 123.456 -> 124
      await expect(market.connect(buyer).buy(1, 1, oddPrice)).to.changeTokenBalances(stable, [buyer, seller], [-124, 124]);
    });

    it("rejects buying more than remains", async () => {
      const { market, buyer, listingId } = await loadFixture(listedFixture);
      await expect(market.connect(buyer).buy(listingId, 2001, PRICE))
        .to.be.revertedWithCustomError(market, "InsufficientListing")
        .withArgs(listingId, 2001, 2000);
    });

    it("rejects zero-amount buys and self-trades", async () => {
      const { market, seller, buyer, listingId } = await loadFixture(listedFixture);
      await expect(market.connect(buyer).buy(listingId, 0, PRICE)).to.be.revertedWithCustomError(market, "ZeroAmount");
      await expect(market.connect(seller).buy(listingId, 100, PRICE)).to.be.revertedWithCustomError(market, "SelfTrade");
    });

    it("rejects unknown listings", async () => {
      const { market, buyer } = await loadFixture(listedFixture);
      await expect(market.connect(buyer).buy(99, 1, PRICE)).to.be.revertedWithCustomError(market, "ListingNotActive");
    });

    it("reverts if the buyer cannot pay", async () => {
      const { market, stable, seller, buyer, token } = await loadFixture(deployFixture);
      const expensive = usdPerKwh(50); // 2 kWh would cost $100; the buyer has $10
      await market.connect(seller).createListing(2000, expensive);
      await expect(market.connect(buyer).buy(1, 2000, expensive)).to.be.revertedWithCustomError(
        stable,
        "ERC20InsufficientBalance",
      );
      expect(await token.balanceOf(buyer.address)).to.equal(0);
    });
  });

  describe("front-running protection", () => {
    it("never fills above the buyer's max price, even if the seller re-prices first", async () => {
      const { market, seller, buyer, listingId, stable } = await loadFixture(listedFixture);
      // The buyer saw $0.14 and signs a buy with that limit; the seller raises the price before it lands.
      await expect(market.connect(seller).updatePrice(listingId, usdPerKwh(0.3)))
        .to.emit(market, "ListingPriceUpdated")
        .withArgs(listingId, PRICE, usdPerKwh(0.3));
      await expect(market.connect(buyer).buy(listingId, 1000, PRICE))
        .to.be.revertedWithCustomError(market, "PriceAboveLimit")
        .withArgs(listingId, usdPerKwh(0.3), PRICE);
      expect(await stable.balanceOf(buyer.address)).to.equal(10n * USD);
    });

    it("fills at the listing price when it is below the limit", async () => {
      const { market, seller, buyer, listingId } = await loadFixture(listedFixture);
      await market.connect(seller).updatePrice(listingId, usdPerKwh(0.1));
      await expect(market.connect(buyer).buy(listingId, 1000, PRICE))
        .to.emit(market, "Trade")
        .withArgs(listingId, seller.address, buyer.address, 1000, usdPerKwh(0.1), 100_000);
    });

    it("only the seller can re-price, and never to zero", async () => {
      const { market, seller, buyer, listingId } = await loadFixture(listedFixture);
      await expect(market.connect(buyer).updatePrice(listingId, 1)).to.be.revertedWithCustomError(market, "NotSeller");
      await expect(market.connect(seller).updatePrice(listingId, 0)).to.be.revertedWithCustomError(market, "ZeroPrice");
    });
  });

  describe("cancellation", () => {
    it("returns unsold credits to the seller", async () => {
      const { market, token, seller, buyer, listingId } = await loadFixture(listedFixture);
      await market.connect(buyer).buy(listingId, 500, PRICE);
      const tx = await market.connect(seller).cancelListing(listingId);
      await expect(tx).to.emit(market, "ListingCancelled").withArgs(listingId, seller.address, 1500);
      await expect(tx).to.changeTokenBalances(token, [seller, await market.getAddress()], [1500, -1500]);

      await expect(market.connect(buyer).buy(listingId, 1, PRICE)).to.be.revertedWithCustomError(market, "ListingNotActive");
      await expect(market.connect(seller).cancelListing(listingId)).to.be.revertedWithCustomError(
        market,
        "ListingNotActive",
      );
    });

    it("only the seller can cancel", async () => {
      const { market, buyer, listingId } = await loadFixture(listedFixture);
      await expect(market.connect(buyer).cancelListing(listingId))
        .to.be.revertedWithCustomError(market, "NotSeller")
        .withArgs(listingId);
    });
  });

  describe("consumption burn", () => {
    it("burns purchased credits when the buyer's meter reports the energy consumed", async () => {
      const { market, token, oracle, buyer, buyerMeter, listingId, t0 } = await loadFixture(listedFixture);
      await market.connect(buyer).buy(listingId, 1500, PRICE);
      const supplyBefore = await token.totalSupply();

      const { reading, signature } = await buyerMeter.sign({ intervalStart: t0, importedWh: 1000 });
      await expect(token.connect(oracle).submitReading(reading, signature))
        .to.emit(token, "CreditsBurned")
        .withArgs(buyer.address, buyerMeter.address, t0, 1000);

      expect(await token.balanceOf(buyer.address)).to.equal(500);
      expect(await token.totalSupply()).to.equal(supplyBefore - 1000n);
    });

    it("never burns credits held in escrow by an open listing", async () => {
      const { token, oracle, seller, sellerMeter, market, t0 } = await loadFixture(deployFixture);
      await market.connect(seller).createListing(2400, PRICE); // everything listed
      const next = t0 + INTERVAL_SECONDS;
      await ethers.provider.send("evm_setNextBlockTimestamp", [next + INTERVAL_SECONDS]);
      const { reading, signature } = await sellerMeter.sign({ intervalStart: next, importedWh: 800 });
      await expect(token.connect(oracle).submitReading(reading, signature)).not.to.emit(token, "CreditsBurned");
      expect(await token.balanceOf(await market.getAddress())).to.equal(2400);
      expect(await token.balanceOf(seller.address)).to.equal(0);
    });
  });

  describe("pause and access control", () => {
    it("blocks listing, re-pricing and buying while paused but always lets sellers cancel", async () => {
      const { market, admin, seller, buyer, listingId } = await loadFixture(listedFixture);
      await expect(market.connect(admin).pause()).to.emit(market, "Paused");

      await expect(market.connect(seller).createListing(100, PRICE)).to.be.revertedWithCustomError(market, "EnforcedPause");
      await expect(market.connect(seller).updatePrice(listingId, 1)).to.be.revertedWithCustomError(market, "EnforcedPause");
      await expect(market.connect(buyer).buy(listingId, 100, PRICE)).to.be.revertedWithCustomError(market, "EnforcedPause");
      await expect(market.connect(seller).cancelListing(listingId)).to.emit(market, "ListingCancelled");

      await market.connect(admin).unpause();
      await expect(market.connect(seller).createListing(100, PRICE)).to.emit(market, "ListingCreated");
    });

    it("halts trading when the energy token itself is paused", async () => {
      const { market, token, admin, buyer, listingId } = await loadFixture(listedFixture);
      await token.connect(admin).pause();
      await expect(market.connect(buyer).buy(listingId, 100, PRICE)).to.be.revertedWithCustomError(token, "EnforcedPause");
    });

    it("only the pauser role can pause", async () => {
      const { market, seller } = await loadFixture(deployFixture);
      await expect(market.connect(seller).pause())
        .to.be.revertedWithCustomError(market, "AccessControlUnauthorizedAccount")
        .withArgs(seller.address, await market.PAUSER_ROLE());
    });

    it("rejects zero addresses at deployment", async () => {
      const [admin] = await ethers.getSigners();
      const factory = new EnergyMarketplace__factory(admin);
      await expect(factory.deploy(admin.address, ethers.ZeroAddress, admin.address)).to.be.revertedWithCustomError(
        factory,
        "ZeroAddress",
      );
    });
  });

  describe("MockStablecoin", () => {
    it("has 6 decimals and owner-only minting", async () => {
      const { stable, buyer } = await loadFixture(deployFixture);
      expect(await stable.decimals()).to.equal(6);
      await expect(stable.connect(buyer).mint(buyer.address, 1)).to.be.revertedWithCustomError(
        stable,
        "OwnableUnauthorizedAccount",
      );
    });
  });
});
