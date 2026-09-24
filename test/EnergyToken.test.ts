import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { TypedDataEncoder, Wallet } from "ethers";
import { EnergyToken__factory } from "../typechain-types";
import { INTERVAL_SECONDS, READING_TYPES, readingDomain, signReading } from "../src/shared/reading";
import {
  MAX_EXPORT_WH,
  MAX_IMPORT_WH,
  TestMeter,
  advanceIntervals,
  domainFor,
  lastFinishedInterval,
} from "./helpers";

describe("EnergyToken", () => {
  async function deployFixture() {
    const [admin, oracle, prosumer, consumer, outsider] = await ethers.getSigners();
    const token = await new EnergyToken__factory(admin).deploy(admin.address);
    await token.grantRole(await token.ORACLE_ROLE(), oracle.address);

    const domain = await domainFor(token);
    const prosumerMeter = new TestMeter(domain);
    const consumerMeter = new TestMeter(domain);
    await token.registerMeter(prosumerMeter.address, prosumer.address, MAX_EXPORT_WH, MAX_IMPORT_WH);
    await token.registerMeter(consumerMeter.address, consumer.address, 0, MAX_IMPORT_WH);

    const t0 = await lastFinishedInterval();
    return { token, admin, oracle, prosumer, consumer, outsider, domain, prosumerMeter, consumerMeter, t0 };
  }

  describe("deployment", () => {
    it("has 1 token = 1 kWh with 1 Wh base units", async () => {
      const { token } = await loadFixture(deployFixture);
      expect(await token.name()).to.equal("Verified Energy Credit");
      expect(await token.symbol()).to.equal("EKWH");
      expect(await token.decimals()).to.equal(3);
      expect(await token.totalSupply()).to.equal(0);
    });

    it("grants admin, registrar and pauser roles to the admin only", async () => {
      const { token, admin, oracle } = await loadFixture(deployFixture);
      expect(await token.hasRole(await token.DEFAULT_ADMIN_ROLE(), admin.address)).to.be.true;
      expect(await token.hasRole(await token.REGISTRAR_ROLE(), admin.address)).to.be.true;
      expect(await token.hasRole(await token.PAUSER_ROLE(), admin.address)).to.be.true;
      expect(await token.hasRole(await token.ORACLE_ROLE(), admin.address)).to.be.false;
      expect(await token.hasRole(await token.REGISTRAR_ROLE(), oracle.address)).to.be.false;
    });

    it("rejects a zero admin", async () => {
      const [admin] = await ethers.getSigners();
      const factory = new EnergyToken__factory(admin);
      await expect(factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });
  });

  describe("meter registry", () => {
    it("registers a meter with its owner and rated capacity", async () => {
      const { token, prosumer } = await loadFixture(deployFixture);
      const meter = Wallet.createRandom().address;
      await expect(token.registerMeter(meter, prosumer.address, 1000, 2000))
        .to.emit(token, "MeterRegistered")
        .withArgs(meter, prosumer.address, 1000, 2000);
      const m = await token.getMeter(meter);
      expect(m.owner).to.equal(prosumer.address);
      expect(m.maxExportWh).to.equal(1000);
      expect(m.maxImportWh).to.equal(2000);
      expect(m.active).to.be.true;
    });

    it("only lets the registrar register meters (not the oracle)", async () => {
      const { token, oracle, outsider } = await loadFixture(deployFixture);
      for (const caller of [oracle, outsider]) {
        await expect(token.connect(caller).registerMeter(Wallet.createRandom().address, caller.address, 1, 1))
          .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
          .withArgs(caller.address, await token.REGISTRAR_ROLE());
      }
    });

    it("never re-registers a meter (which would reset its replay history)", async () => {
      const { token, prosumerMeter, outsider } = await loadFixture(deployFixture);
      await expect(token.registerMeter(prosumerMeter.address, outsider.address, 1, 1))
        .to.be.revertedWithCustomError(token, "MeterAlreadyRegistered")
        .withArgs(prosumerMeter.address);
    });

    it("rejects zero addresses", async () => {
      const { token, prosumer } = await loadFixture(deployFixture);
      await expect(token.registerMeter(ethers.ZeroAddress, prosumer.address, 1, 1)).to.be.revertedWithCustomError(
        token,
        "ZeroAddress",
      );
      await expect(token.registerMeter(Wallet.createRandom().address, ethers.ZeroAddress, 1, 1)).to.be.revertedWithCustomError(
        token,
        "ZeroAddress",
      );
    });

    it("suspends and reinstates meters", async () => {
      const { token, oracle, prosumerMeter, t0 } = await loadFixture(deployFixture);
      await expect(token.setMeterActive(prosumerMeter.address, false))
        .to.emit(token, "MeterStatusChanged")
        .withArgs(prosumerMeter.address, false);

      const r1 = await prosumerMeter.sign({ intervalStart: t0, exportedWh: 100 });
      await expect(token.connect(oracle).submitReading(r1.reading, r1.signature))
        .to.be.revertedWithCustomError(token, "MeterNotActive")
        .withArgs(prosumerMeter.address);

      await token.setMeterActive(prosumerMeter.address, true);
      await expect(token.connect(oracle).submitReading(r1.reading, r1.signature)).to.emit(token, "ReadingSettled");
    });

    it("rejects status changes for unknown meters", async () => {
      const { token } = await loadFixture(deployFixture);
      const unknown = Wallet.createRandom().address;
      await expect(token.setMeterActive(unknown, false)).to.be.revertedWithCustomError(token, "UnknownMeter").withArgs(unknown);
    });
  });

  describe("minting rules", () => {
    it("mints exported Wh to the meter owner for a valid signed reading", async () => {
      const { token, oracle, prosumer, prosumerMeter, t0 } = await loadFixture(deployFixture);
      const { reading, signature } = await prosumerMeter.sign({ intervalStart: t0, exportedWh: 1000 });

      await expect(token.connect(oracle).submitReading(reading, signature))
        .to.emit(token, "ReadingSettled")
        .withArgs(prosumerMeter.address, prosumer.address, t0, reading.nonce, 1000, 0)
        .and.to.emit(token, "CreditsMinted")
        .withArgs(prosumer.address, prosumerMeter.address, t0, 1000)
        .and.to.emit(token, "Transfer")
        .withArgs(ethers.ZeroAddress, prosumer.address, 1000);

      // 1000 Wh = 1.000 EKWH = 1 kWh
      expect(ethers.formatUnits(await token.balanceOf(prosumer.address), 3)).to.equal("1.0");
      expect(await token.totalSupply()).to.equal(1000);

      const m = await token.getMeter(prosumerMeter.address);
      expect(m.lastNonce).to.equal(reading.nonce);
      expect(m.lastIntervalStart).to.equal(t0);
    });

    it("mints nothing for a zero-export reading", async () => {
      const { token, oracle, prosumer, prosumerMeter, t0 } = await loadFixture(deployFixture);
      const { reading, signature } = await prosumerMeter.sign({ intervalStart: t0 });
      await expect(token.connect(oracle).submitReading(reading, signature)).not.to.emit(token, "CreditsMinted");
      expect(await token.balanceOf(prosumer.address)).to.equal(0);
    });

    it("only the oracle can submit readings, even with a valid meter signature", async () => {
      const { token, prosumer, outsider, admin, prosumerMeter, t0 } = await loadFixture(deployFixture);
      const { reading, signature } = await prosumerMeter.sign({ intervalStart: t0, exportedWh: 500 });
      for (const caller of [outsider, prosumer, admin]) {
        await expect(token.connect(caller).submitReading(reading, signature))
          .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
          .withArgs(caller.address, await token.ORACLE_ROLE());
      }
    });

    it("has no mint function other than submitReading", async () => {
      const { token } = await loadFixture(deployFixture);
      expect(token.interface.getFunction("mint")).to.be.null;
    });

    it("stops a revoked oracle from minting", async () => {
      const { token, oracle, prosumerMeter, t0 } = await loadFixture(deployFixture);
      await token.revokeRole(await token.ORACLE_ROLE(), oracle.address);
      const { reading, signature } = await prosumerMeter.sign({ intervalStart: t0, exportedWh: 500 });
      await expect(token.connect(oracle).submitReading(reading, signature)).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("rejects exports above the meter's rated capacity", async () => {
      const { token, oracle, prosumerMeter, t0 } = await loadFixture(deployFixture);
      const over = await prosumerMeter.sign({ intervalStart: t0, exportedWh: MAX_EXPORT_WH + 1 });
      await expect(token.connect(oracle).submitReading(over.reading, over.signature))
        .to.be.revertedWithCustomError(token, "ExportAboveCapacity")
        .withArgs(prosumerMeter.address, MAX_EXPORT_WH + 1, MAX_EXPORT_WH);

      const atCap = await prosumerMeter.sign({ intervalStart: t0, exportedWh: MAX_EXPORT_WH });
      await expect(token.connect(oracle).submitReading(atCap.reading, atCap.signature)).to.emit(token, "CreditsMinted");
    });

    it("rejects imports above the service connection limit", async () => {
      const { token, oracle, consumerMeter, t0 } = await loadFixture(deployFixture);
      const { reading, signature } = await consumerMeter.sign({ intervalStart: t0, importedWh: MAX_IMPORT_WH + 1 });
      await expect(token.connect(oracle).submitReading(reading, signature)).to.be.revertedWithCustomError(
        token,
        "ImportAboveCapacity",
      );
    });

    it("rejects exports from a consumer-only meter (rated export 0)", async () => {
      const { token, oracle, consumerMeter, t0 } = await loadFixture(deployFixture);
      const { reading, signature } = await consumerMeter.sign({ intervalStart: t0, exportedWh: 1 });
      await expect(token.connect(oracle).submitReading(reading, signature)).to.be.revertedWithCustomError(
        token,
        "ExportAboveCapacity",
      );
    });
  });

  describe("signed meter data", () => {
    it("rejects a reading signed by a key other than the meter's (spoofed meter)", async () => {
      const { token, oracle, domain, prosumerMeter, t0 } = await loadFixture(deployFixture);
      const reading = { meter: prosumerMeter.address, intervalStart: t0, exportedWh: 1000, importedWh: 0, nonce: 1 };
      const forged = await signReading(Wallet.createRandom(), domain, reading);
      await expect(token.connect(oracle).submitReading(reading, forged))
        .to.be.revertedWithCustomError(token, "InvalidMeterSignature")
        .withArgs(prosumerMeter.address);
    });

    it("rejects a reading altered after signing", async () => {
      const { token, oracle, prosumerMeter, t0 } = await loadFixture(deployFixture);
      const { reading, signature } = await prosumerMeter.sign({ intervalStart: t0, exportedWh: 100 });
      const tampered = { ...reading, exportedWh: 1400 };
      await expect(token.connect(oracle).submitReading(tampered, signature)).to.be.revertedWithCustomError(
        token,
        "InvalidMeterSignature",
      );
    });

    it("rejects a signature made for a different contract (cross-deployment replay)", async () => {
      const { token, oracle, prosumerMeter, t0 } = await loadFixture(deployFixture);
      const { chainId } = await ethers.provider.getNetwork();
      const otherDomain = readingDomain(chainId, Wallet.createRandom().address);
      const reading = { meter: prosumerMeter.address, intervalStart: t0, exportedWh: 100, importedWh: 0, nonce: 1 };
      const signature = await signReading(prosumerMeter.wallet, otherDomain, reading);
      await expect(token.connect(oracle).submitReading(reading, signature)).to.be.revertedWithCustomError(
        token,
        "InvalidMeterSignature",
      );
    });

    it("rejects malformed signatures", async () => {
      const { token, oracle, prosumerMeter, t0 } = await loadFixture(deployFixture);
      const { reading } = await prosumerMeter.sign({ intervalStart: t0, exportedWh: 100 });
      await expect(token.connect(oracle).submitReading(reading, "0x1234")).to.be.revertedWithCustomError(
        token,
        "InvalidMeterSignature",
      );
    });

    it("rejects readings from unregistered meters", async () => {
      const { token, oracle, domain, t0 } = await loadFixture(deployFixture);
      const rogue = new TestMeter(domain);
      const { reading, signature } = await rogue.sign({ intervalStart: t0, exportedWh: 100 });
      await expect(token.connect(oracle).submitReading(reading, signature))
        .to.be.revertedWithCustomError(token, "UnknownMeter")
        .withArgs(rogue.address);
    });

    it("computes the same EIP-712 digest as off-chain tooling", async () => {
      const { token, domain, prosumerMeter, t0 } = await loadFixture(deployFixture);
      const { reading } = await prosumerMeter.sign({ intervalStart: t0, exportedWh: 42 });
      expect(await token.readingDigest(reading)).to.equal(TypedDataEncoder.hash(domain, READING_TYPES, reading));
    });
  });

  describe("replay protection and double counting", () => {
    it("rejects an exact replay of a settled reading", async () => {
      const { token, oracle, prosumerMeter, t0 } = await loadFixture(deployFixture);
      const { reading, signature } = await prosumerMeter.sign({ intervalStart: t0, exportedWh: 500 });
      await token.connect(oracle).submitReading(reading, signature);
      await expect(token.connect(oracle).submitReading(reading, signature))
        .to.be.revertedWithCustomError(token, "IntervalAlreadySettled")
        .withArgs(prosumerMeter.address, t0);
    });

    it("rejects a second reading for an already-settled interval, even with a fresh nonce", async () => {
      const { token, oracle, prosumer, prosumerMeter, t0 } = await loadFixture(deployFixture);
      const first = await prosumerMeter.sign({ intervalStart: t0, exportedWh: 500 });
      await token.connect(oracle).submitReading(first.reading, first.signature);

      const again = await prosumerMeter.sign({ intervalStart: t0, exportedWh: 500 }); // nonce 2
      await expect(token.connect(oracle).submitReading(again.reading, again.signature)).to.be.revertedWithCustomError(
        token,
        "IntervalAlreadySettled",
      );
      const older = await prosumerMeter.sign({ intervalStart: t0 - INTERVAL_SECONDS, exportedWh: 500 });
      await expect(token.connect(oracle).submitReading(older.reading, older.signature)).to.be.revertedWithCustomError(
        token,
        "IntervalAlreadySettled",
      );
      expect(await token.balanceOf(prosumer.address)).to.equal(500);
    });

    it("rejects a non-increasing nonce", async () => {
      const { token, oracle, prosumerMeter, t0 } = await loadFixture(deployFixture);
      const first = await prosumerMeter.sign({ intervalStart: t0 - INTERVAL_SECONDS, exportedWh: 100 });
      await token.connect(oracle).submitReading(first.reading, first.signature);

      const stale = await prosumerMeter.sign({ intervalStart: t0, exportedWh: 100, nonce: first.reading.nonce });
      await expect(token.connect(oracle).submitReading(stale.reading, stale.signature))
        .to.be.revertedWithCustomError(token, "StaleNonce")
        .withArgs(prosumerMeter.address, first.reading.nonce);
    });

    it("accepts consecutive intervals with increasing nonces (gaps allowed)", async () => {
      const { token, oracle, prosumer, prosumerMeter, t0 } = await loadFixture(deployFixture);
      const a = await prosumerMeter.sign({ intervalStart: t0 - 2 * INTERVAL_SECONDS, exportedWh: 100 });
      prosumerMeter.nonce += 3; // e.g. readings the oracle rejected
      const b = await prosumerMeter.sign({ intervalStart: t0, exportedWh: 200 });
      await token.connect(oracle).submitReading(a.reading, a.signature);
      await token.connect(oracle).submitReading(b.reading, b.signature);
      expect(await token.balanceOf(prosumer.address)).to.equal(300);
    });

    it("rejects readings for intervals that have not finished yet", async () => {
      const { token, oracle, prosumerMeter, t0 } = await loadFixture(deployFixture);
      const current = t0 + INTERVAL_SECONDS; // still in progress
      const { reading, signature } = await prosumerMeter.sign({ intervalStart: current, exportedWh: 100 });
      await expect(token.connect(oracle).submitReading(reading, signature))
        .to.be.revertedWithCustomError(token, "IntervalNotFinished")
        .withArgs(current);

      await advanceIntervals(1);
      await expect(token.connect(oracle).submitReading(reading, signature)).to.emit(token, "CreditsMinted");
    });

    it("rejects intervals not aligned to 15 minutes", async () => {
      const { token, oracle, prosumerMeter, t0 } = await loadFixture(deployFixture);
      const { reading, signature } = await prosumerMeter.sign({ intervalStart: t0 - 60, exportedWh: 100 });
      await expect(token.connect(oracle).submitReading(reading, signature)).to.be.revertedWithCustomError(
        token,
        "IntervalNotAligned",
      );
    });
  });

  describe("consumption burn", () => {
    async function withCredits() {
      const f = await deployFixture();
      const { token, oracle, prosumer, consumer, prosumerMeter, t0 } = f;
      const r = await prosumerMeter.sign({ intervalStart: t0 - INTERVAL_SECONDS, exportedWh: 1200 });
      await token.connect(oracle).submitReading(r.reading, r.signature);
      await token.connect(prosumer).transfer(consumer.address, 800);
      return f;
    }

    it("burns credits for energy the owner imported", async () => {
      const { token, oracle, consumer, consumerMeter, t0 } = await loadFixture(withCredits);
      const { reading, signature } = await consumerMeter.sign({ intervalStart: t0, importedWh: 300 });
      await expect(token.connect(oracle).submitReading(reading, signature))
        .to.emit(token, "CreditsBurned")
        .withArgs(consumer.address, consumerMeter.address, t0, 300)
        .and.to.emit(token, "Transfer")
        .withArgs(consumer.address, ethers.ZeroAddress, 300);
      expect(await token.balanceOf(consumer.address)).to.equal(500);
      expect(await token.totalSupply()).to.equal(900);
    });

    it("burns at most the owner's balance (the rest is ordinary grid supply)", async () => {
      const { token, oracle, consumer, consumerMeter, t0 } = await loadFixture(withCredits);
      const { reading, signature } = await consumerMeter.sign({ intervalStart: t0, importedWh: 5000 });
      await expect(token.connect(oracle).submitReading(reading, signature))
        .to.emit(token, "CreditsBurned")
        .withArgs(consumer.address, consumerMeter.address, t0, 800);
      expect(await token.balanceOf(consumer.address)).to.equal(0);
    });

    it("burns nothing when the owner holds no credits", async () => {
      const { token, oracle, t0, domain, admin } = await loadFixture(withCredits);
      const meter = new TestMeter(domain);
      await token.registerMeter(meter.address, admin.address, 0, MAX_IMPORT_WH);
      const { reading, signature } = await meter.sign({ intervalStart: t0, importedWh: 400 });
      await expect(token.connect(oracle).submitReading(reading, signature))
        .to.emit(token, "ReadingSettled")
        .and.not.to.emit(token, "CreditsBurned");
    });

    it("nets export and import within one interval (mint, then burn)", async () => {
      const { token, oracle, prosumer, prosumerMeter, t0 } = await loadFixture(withCredits);
      const before = await token.balanceOf(prosumer.address); // 400
      const { reading, signature } = await prosumerMeter.sign({ intervalStart: t0, exportedWh: 300, importedWh: 100 });
      await token.connect(oracle).submitReading(reading, signature);
      expect(await token.balanceOf(prosumer.address)).to.equal(before + 200n);
    });
  });

  describe("pause", () => {
    it("blocks minting, burning and transfers while paused", async () => {
      const { token, admin, oracle, prosumer, consumer, prosumerMeter, t0 } = await loadFixture(deployFixture);
      const first = await prosumerMeter.sign({ intervalStart: t0 - INTERVAL_SECONDS, exportedWh: 100 });
      await token.connect(oracle).submitReading(first.reading, first.signature);

      await expect(token.connect(admin).pause()).to.emit(token, "Paused");
      const { reading, signature } = await prosumerMeter.sign({ intervalStart: t0, exportedWh: 100 });
      await expect(token.connect(oracle).submitReading(reading, signature)).to.be.revertedWithCustomError(
        token,
        "EnforcedPause",
      );
      await expect(token.connect(prosumer).transfer(consumer.address, 1)).to.be.revertedWithCustomError(
        token,
        "EnforcedPause",
      );

      await token.connect(admin).unpause();
      await expect(token.connect(oracle).submitReading(reading, signature)).to.emit(token, "CreditsMinted");
      await expect(token.connect(prosumer).transfer(consumer.address, 1)).not.to.be.reverted;
    });

    it("only the pauser role can pause or unpause", async () => {
      const { token, oracle, outsider } = await loadFixture(deployFixture);
      for (const caller of [oracle, outsider]) {
        await expect(token.connect(caller).pause()).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      }
      await token.pause();
      await expect(token.connect(outsider).unpause()).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("role administration", () => {
    it("only the admin can grant roles", async () => {
      const { token, oracle, outsider } = await loadFixture(deployFixture);
      const ORACLE_ROLE = await token.ORACLE_ROLE();
      await expect(token.connect(oracle).grantRole(ORACLE_ROLE, outsider.address))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(oracle.address, await token.DEFAULT_ADMIN_ROLE());
      await expect(token.grantRole(ORACLE_ROLE, outsider.address))
        .to.emit(token, "RoleGranted")
        .withArgs(ORACLE_ROLE, outsider.address, (await ethers.getSigners())[0].address);
    });
  });
});
