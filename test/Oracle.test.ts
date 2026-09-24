import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { Wallet } from "ethers";
import { EnergyToken__factory } from "../typechain-types";
import { Oracle } from "../src/oracle/oracle";
import { parseSignedReading, validateReading, type ValidationContext } from "../src/oracle/validation";
import { INTERVAL_SECONDS, readingDomain, signReading, type SignedReading } from "../src/shared/reading";
import { MAX_EXPORT_WH, MAX_IMPORT_WH, TestMeter, domainFor, lastFinishedInterval } from "./helpers";

describe("Oracle", () => {
  describe("validation rules (off-chain, pure)", () => {
    const domain = readingDomain(31337, "0x" + "ab".repeat(20));
    const NOW = 1_782_000_000; // aligned to 15 minutes
    const T = NOW - INTERVAL_SECONDS; // last finished interval
    const meter = new TestMeter(domain);

    function ctx(overrides: Partial<ValidationContext> = {}): ValidationContext {
      return {
        domain,
        nowSeconds: NOW,
        maxReadingAgeSeconds: 6 * 3600,
        meter: { owner: Wallet.createRandom().address, maxExportWh: MAX_EXPORT_WH, maxImportWh: MAX_IMPORT_WH, active: true },
        cursor: { lastNonce: 0, lastIntervalStart: 0 },
        seenDigests: new Set(),
        ...overrides,
      };
    }

    async function codeFor(signed: SignedReading, c = ctx()) {
      const v = validateReading(signed, c);
      return v.ok ? "OK" : v.code;
    }

    it("accepts a well-formed, signed, plausible reading", async () => {
      expect(await codeFor(await meter.sign({ intervalStart: T, exportedWh: 900 }))).to.equal("OK");
    });

    it("rejects malformed bodies before doing anything else", () => {
      const bad = [
        null,
        {},
        { reading: { meter: "nope" }, signature: "0x00" },
        { reading: { meter: meter.address, intervalStart: T, exportedWh: -5, importedWh: 0, nonce: 1 }, signature: "0x00" },
        { reading: { meter: meter.address, intervalStart: T, exportedWh: 2 ** 32, importedWh: 0, nonce: 1 }, signature: "0x00" },
        { reading: { meter: meter.address, intervalStart: T, exportedWh: 1.5, importedWh: 0, nonce: 1 }, signature: "0x00" },
        { reading: { meter: meter.address, intervalStart: T, exportedWh: 1, importedWh: 0, nonce: 1 }, signature: 42 },
      ];
      for (const body of bad) {
        const parsed = parseSignedReading(body);
        expect(parsed).to.have.property("code", "MALFORMED");
      }
    });

    it("rejects spoofed meters: a signature from any other key", async () => {
      const reading = { meter: meter.address, intervalStart: T, exportedWh: 900, importedWh: 0, nonce: 99 };
      const forged = await signReading(Wallet.createRandom(), domain, reading);
      expect(await codeFor({ reading, signature: forged })).to.equal("BAD_SIGNATURE");
      expect(await codeFor({ reading, signature: "0x1234" })).to.equal("BAD_SIGNATURE");
    });

    it("rejects unregistered and suspended meters", async () => {
      const signed = await meter.sign({ intervalStart: T, exportedWh: 900 });
      expect(await codeFor(signed, ctx({ meter: undefined }))).to.equal("UNKNOWN_METER");
      expect(
        await codeFor(signed, ctx({ meter: { owner: meter.address, maxExportWh: 1, maxImportWh: 1, active: false } })),
      ).to.equal("METER_INACTIVE");
    });

    it("rejects misaligned, unfinished and stale intervals", async () => {
      expect(await codeFor(await meter.sign({ intervalStart: T + 60 }))).to.equal("MISALIGNED_INTERVAL");
      expect(await codeFor(await meter.sign({ intervalStart: NOW }))).to.equal("FUTURE_INTERVAL");
      expect(await codeFor(await meter.sign({ intervalStart: T - 7 * 3600 }))).to.equal("STALE_READING");
    });

    it("rejects exact replays, double counting and reused nonces", async () => {
      const signed = await meter.sign({ intervalStart: T, exportedWh: 500 });
      const first = validateReading(signed, ctx());
      expect(first.ok).to.be.true;
      const digest = (first as { digest: string }).digest;
      const after = { lastNonce: signed.reading.nonce, lastIntervalStart: T };

      expect(await codeFor(signed, ctx({ seenDigests: new Set([digest]), cursor: after }))).to.equal("DUPLICATE");
      const sameInterval = await meter.sign({ intervalStart: T, exportedWh: 500 });
      expect(await codeFor(sameInterval, ctx({ cursor: after }))).to.equal("INTERVAL_ALREADY_SETTLED");
      const reusedNonce = await meter.sign({ intervalStart: NOW - 0, exportedWh: 1 });
      const laterCtx = ctx({ nowSeconds: NOW + INTERVAL_SECONDS, cursor: { lastNonce: reusedNonce.reading.nonce, lastIntervalStart: T } });
      expect(await codeFor(reusedNonce, laterCtx)).to.equal("REPLAYED_NONCE");
    });

    it("rejects physically implausible values", async () => {
      expect(await codeFor(await meter.sign({ intervalStart: T, exportedWh: MAX_EXPORT_WH + 1 }))).to.equal(
        "EXPORT_ABOVE_CAPACITY",
      );
      expect(await codeFor(await meter.sign({ intervalStart: T, importedWh: MAX_IMPORT_WH + 1 }))).to.equal(
        "IMPORT_ABOVE_CAPACITY",
      );
    });
  });

  describe("service (against a local chain)", () => {
    async function deployFixture() {
      const [admin, oracleSigner, prosumer] = await ethers.getSigners();
      const token = await new EnergyToken__factory(admin).deploy(admin.address);
      await token.grantRole(await token.ORACLE_ROLE(), oracleSigner.address);
      const domain = await domainFor(token);
      const meter = new TestMeter(domain);
      await token.registerMeter(meter.address, prosumer.address, MAX_EXPORT_WH, MAX_IMPORT_WH);
      return { admin, oracleSigner, prosumer, token, domain, meter, t0: await lastFinishedInterval() };
    }

    // The oracle keeps in-memory state, so each test gets a fresh one (loadFixture only resets the chain).
    async function fixture() {
      const f = await loadFixture(deployFixture);
      return { ...f, oracle: new Oracle(f.token.connect(f.oracleSigner), ethers.provider, f.domain) };
    }

    it("settles valid readings on-chain and rejects replays", async () => {
      const { token, prosumer, meter, oracle, t0 } = await fixture();
      const signed = await meter.sign({ intervalStart: t0, exportedWh: 750 });

      const ok = await oracle.handle(signed);
      expect(ok.status).to.equal("settled");
      expect(ok.mintedWh).to.equal(750);
      expect(await token.balanceOf(prosumer.address)).to.equal(750);

      const replay = await oracle.handle(JSON.parse(JSON.stringify(signed)));
      expect(replay).to.include({ status: "rejected", code: "DUPLICATE" });
      expect(oracle.stats).to.include({ received: 2, settled: 1, rejected: 1, queued: 0 });
    });

    it("queues readings while the token is paused and settles them in order after unpause", async () => {
      const { token, admin, prosumer, meter, oracle, t0 } = await fixture();
      await token.connect(admin).pause();

      const a = await meter.sign({ intervalStart: t0 - INTERVAL_SECONDS, exportedWh: 100 });
      const b = await meter.sign({ intervalStart: t0, exportedWh: 200 });
      expect((await oracle.handle(a)).status).to.equal("queued");
      expect((await oracle.handle(b)).status).to.equal("queued");
      expect(oracle.queueLength).to.equal(2);

      await token.connect(admin).unpause();
      await oracle.drain();
      expect(oracle.queueLength).to.equal(0);
      expect(await token.balanceOf(prosumer.address)).to.equal(300);
      expect(oracle.stats).to.include({ settled: 2, queued: 0 });
    });
  });
});
