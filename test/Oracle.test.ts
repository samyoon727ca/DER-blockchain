import { expect } from "chai";
import type { AddressInfo } from "node:net";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { Signature, Wallet } from "ethers";
import { EnergyToken__factory, type EnergyToken } from "../typechain-types";
import { Oracle } from "../src/oracle/oracle";
import { MAX_BODY_BYTES, startOracleServer } from "../src/oracle/server";
import { parseSignedReading, validateReading, type ValidationContext } from "../src/oracle/validation";
import { INTERVAL_SECONDS, readingDomain, signReading, type SignedReading } from "../src/shared/reading";
import { MAX_EXPORT_WH, MAX_IMPORT_WH, TestMeter, domainFor, lastFinishedInterval } from "./helpers";

/** The same signature in encodings ethers accepts but OpenZeppelin's ECDSA (and so EnergyToken) refuses. */
function nonCanonical(signature: string): Record<string, string> {
  const sig = Signature.from(signature);
  const rs = sig.r + sig.s.slice(2);
  return {
    "64-byte compact (EIP-2098)": sig.compactSerialized,
    "v = 0/1": rs + (sig.v - 27).toString(16).padStart(2, "0"),
    "v = 35/36 (EIP-155 style)": rs + (sig.v - 27 + 35).toString(16),
  };
}

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

    it("rejects signature encodings the contract would refuse (compact, v = 0/1, EIP-155 v)", async () => {
      const signed = await meter.sign({ intervalStart: T, exportedWh: 900 });
      for (const [form, signature] of Object.entries(nonCanonical(signed.signature))) {
        expect(await codeFor({ reading: signed.reading, signature }), form).to.equal("BAD_SIGNATURE");
      }
      expect(await codeFor(signed)).to.equal("OK");
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

    it("refuses exactly the signature encodings the contract refuses, so the genuine reading still settles", async () => {
      const { token, oracleSigner, prosumer, meter, oracle, t0 } = await fixture();
      const signed = await meter.sign({ intervalStart: t0, exportedWh: 750 });
      for (const [form, signature] of Object.entries(nonCanonical(signed.signature))) {
        await expect(token.connect(oracleSigner).submitReading(signed.reading, signature), form).to.be.revertedWithCustomError(
          token,
          "InvalidMeterSignature",
        );
        expect(await oracle.handle({ reading: signed.reading, signature }), form).to.include({ status: "rejected", code: "BAD_SIGNATURE" });
      }
      expect(await oracle.handle(signed)).to.include({ status: "settled", mintedWh: 750 });
      expect(await token.balanceOf(prosumer.address)).to.equal(750);
    });

    it("forgets a reading the chain refused, so the same reading can settle once the cause is fixed", async () => {
      const { token, admin, prosumer, meter, oracle, t0 } = await fixture();
      const signed = await meter.sign({ intervalStart: t0, exportedWh: 400 });
      await token.connect(admin).pause();
      expect((await oracle.handle(signed)).status).to.equal("queued");

      // The registrar suspends the meter while the reading waits in the queue.
      await token.connect(admin).setMeterActive(meter.address, false);
      await token.connect(admin).unpause();
      await oracle.drain();
      expect(oracle.rejections.at(-1)).to.include({ code: "ONCHAIN_REVERT", detail: "MeterNotActive" });

      await token.connect(admin).setMeterActive(meter.address, true);
      expect(await oracle.handle(JSON.parse(JSON.stringify(signed)))).to.include({ status: "settled", mintedWh: 400 });
      expect(await token.balanceOf(prosumer.address)).to.equal(400);
    });

    it("reconciles a submission that was mined although its confirmation was lost", async () => {
      const { token, oracleSigner, prosumer, meter, domain, t0 } = await loadFixture(deployFixture);
      const real = token.connect(oracleSigner);
      let loseConfirmation = true;
      // Wrap the token so the first transaction is mined but wait() fails, like a dropped RPC response.
      const flaky = new Proxy(real, {
        get(target, prop) {
          if (prop !== "submitReading") return target[prop as keyof EnergyToken];
          return async (...args: Parameters<EnergyToken["submitReading"]>) => {
            const tx = await target.submitReading(...args);
            if (!loseConfirmation) return tx;
            loseConfirmation = false;
            await tx.wait();
            return { hash: tx.hash, wait: () => Promise.reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" })) };
          };
        },
      });
      const oracle = new Oracle(flaky, ethers.provider, domain);

      expect((await oracle.handle(await meter.sign({ intervalStart: t0, exportedWh: 750 }))).status).to.equal("queued");
      expect(await token.balanceOf(prosumer.address)).to.equal(750);
      await oracle.drain();
      expect(oracle.queueLength).to.equal(0);
      expect(oracle.stats).to.include({ settled: 1, rejected: 0, queued: 0 });
      expect(oracle.log.at(-1)).to.include({ status: "settled", mintedWh: 750 });
    });

    it("picks up the chain's cursor after a restart, so settled intervals stay settled", async () => {
      const { token, oracleSigner, meter, domain, oracle, t0 } = await fixture();
      const signed = await meter.sign({ intervalStart: t0, exportedWh: 300 });
      expect((await oracle.handle(signed)).status).to.equal("settled");

      const restarted = new Oracle(token.connect(oracleSigner), ethers.provider, domain);
      expect(await restarted.handle(JSON.parse(JSON.stringify(signed)))).to.include({ code: "INTERVAL_ALREADY_SETTLED" });
      expect(await restarted.handle(await meter.sign({ intervalStart: t0, exportedWh: 300 }))).to.include({
        code: "INTERVAL_ALREADY_SETTLED",
      });
    });
  });

  describe("HTTP server", () => {
    it(`answers 413 to bodies over ${MAX_BODY_BYTES / 1024} KB without handing them to the oracle`, async () => {
      let handled = 0;
      const stub = { handle: async () => (handled++, { status: "rejected", code: "MALFORMED" }), status: () => ({}) };
      const server = await startOracleServer(stub as unknown as Oracle, 0);
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/readings`;
      try {
        const small = await fetch(url, { method: "POST", body: "{}" });
        expect(small.status).to.equal(422);
        const big = await fetch(url, { method: "POST", body: "x".repeat(MAX_BODY_BYTES + 1) });
        expect(big.status).to.equal(413);
        expect(handled).to.equal(1);
      } finally {
        server.close();
      }
    });
  });
});
