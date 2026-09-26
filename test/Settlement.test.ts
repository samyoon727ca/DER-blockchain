import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SmartMeter } from "../src/meter-simulator/meter";
import { buildSettlement } from "../src/settlement/report";
import { connectContracts } from "../src/shared/chain";
import { deployMarketplace } from "../src/shared/deploy";
import { PARTICIPANTS, meterKey } from "../src/shared/participants";
import { INTERVAL_SECONDS, READING_TYPES, readingDomain } from "../src/shared/reading";
import { USD, usdPerKwh } from "../src/shared/units";
import { advanceIntervals, lastFinishedInterval } from "./helpers";

describe("Settlement report", () => {
  /** P2 exports 1 kWh and lists it; C1 buys 600 Wh, then imports 800 Wh (600 from credits, 200 from the grid). */
  async function tradedFixture() {
    const [admin, oracleSigner, prosumerWallet, consumerWallet] = await ethers.getSigners();
    const spec = (id: string) => PARTICIPANTS.find((p) => p.id === id)!;
    const deployment = await deployMarketplace({
      admin,
      oracle: oracleSigner.address,
      participants: [
        { spec: spec("P2"), wallet: prosumerWallet.address },
        { spec: spec("C1"), wallet: consumerWallet.address },
      ],
      rpcUrl: "in-process",
      simDate: "2026-06-21",
    });
    const domain = readingDomain(deployment.chainId, deployment.contracts.energyToken);
    const oracle = connectContracts(deployment, oracleSigner).token;
    const prosumer = connectContracts(deployment, prosumerWallet);
    const consumer = connectContracts(deployment, consumerWallet);
    const t0 = await lastFinishedInterval();

    const p2 = await new SmartMeter("P2", meterKey("P2"), domain).sign({ intervalStart: t0, exportedWh: 1000, importedWh: 0 });
    await oracle.submitReading(p2.reading, p2.signature);
    await prosumer.token.approve(deployment.contracts.marketplace, 1000);
    await prosumer.market.createListing(1000, usdPerKwh(0.12));
    await consumer.stable.approve(deployment.contracts.marketplace, USD);
    await consumer.market.buy(1, 600, usdPerKwh(0.12));

    await advanceIntervals(1);
    const c1 = await new SmartMeter("C1", meterKey("C1"), domain).sign({
      intervalStart: t0 + INTERVAL_SECONDS,
      exportedWh: 0,
      importedWh: 800,
    });
    await oracle.submitReading(c1.reading, c1.signature);
    return { deployment, admin, prosumerWallet, consumerWallet };
  }

  it("passes every integrity check for a consistent history", async () => {
    const { deployment } = await loadFixture(tradedFixture);
    const report = await buildSettlement(deployment, ethers.provider);
    expect(report.checks.filter((c) => !c.ok)).to.deep.equal([]);
    expect(report.block).to.equal(await ethers.provider.getBlockNumber());
    expect(report.counts).to.include({ readings: 2, listings: 1, trades: 1 });
    const c1 = report.participants.find((p) => p.id === "C1")!;
    expect(c1).to.include({ boughtKwh: 0.6, spentUsd: 0.072, creditsBurnedKwh: 0.6, gridSuppliedKwh: 0.2 });
    // 0.6 kWh of imports covered by credits: $0.18 at grid retail, for which C1 paid $0.072.
    expect(c1.savingsVsGridUsd).to.be.closeTo(0.108, 1e-9);
  });

  it("reads everything at one block, even while more readings settle during the report", async () => {
    const { deployment } = await loadFixture(tradedFixture);
    const [, oracleSigner] = await ethers.getSigners();
    const domain = readingDomain(deployment.chainId, deployment.contracts.energyToken);
    const settleAnotherExport = async () => {
      const reading = { meter: meterKey("P2").address, intervalStart: BigInt(await lastFinishedInterval()), exportedWh: 500n, importedWh: 0n, nonce: 2n };
      const signature = await meterKey("P2").signTypedData(domain, READING_TYPES, reading);
      await (await connectContracts(deployment, oracleSigner).token.submitReading(reading, signature)).wait();
    };
    // Once the report has read events and starts reading balances, another reading settles,
    // as happens when `npm run report` runs while the demo is still going.
    let raced = false;
    const racing = new Proxy(ethers.provider, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        if (prop !== "call") return value.bind(target);
        return async (...args: unknown[]) => {
          if (!raced) {
            raced = true;
            await settleAnotherExport();
          }
          return value.apply(target, args);
        };
      },
    });
    const report = await buildSettlement(deployment, racing);
    expect(raced).to.equal(true);
    expect(report.totals.mintedKwh).to.equal(1);
    expect(report.checks.filter((c) => !c.ok)).to.deep.equal([]);
  });

  it("re-verifies readings exactly, including nonces beyond JavaScript's safe integers", async () => {
    const { deployment } = await loadFixture(tradedFixture);
    const [, oracleSigner] = await ethers.getSigners();
    await advanceIntervals(1);
    // A meter-signed reading submitted straight to the contract (the oracle itself refuses such nonces).
    const reading = {
      meter: meterKey("P2").address,
      intervalStart: BigInt(await lastFinishedInterval()),
      exportedWh: 10n,
      importedWh: 0n,
      nonce: 2n ** 60n + 1n,
    };
    const domain = readingDomain(deployment.chainId, deployment.contracts.energyToken);
    const signature = await meterKey("P2").signTypedData(domain, READING_TYPES, reading);
    await connectContracts(deployment, oracleSigner).token.submitReading(reading, signature);
    const report = await buildSettlement(deployment, ethers.provider);
    expect(report.checks.find((c) => c.name === "Every credit traces to a signed meter reading")).to.include({ ok: true });
  });

  it("re-verifies each reading's meter signature from calldata rather than trusting events", async () => {
    const { deployment } = await loadFixture(tradedFixture);
    // Signatures made for this token do not verify under another chain's EIP-712 domain.
    const report = await buildSettlement({ ...deployment, chainId: 1 }, ethers.provider);
    const check = report.checks.find((c) => c.name === "Every credit traces to a signed meter reading")!;
    expect(check.ok).to.equal(false);
    expect(check.detail).to.match(/^0 of 2 readings re-verified/);
  });

  it("accounts for credits a household sends to a wallet outside the demo", async () => {
    const { deployment, prosumerWallet } = await loadFixture(tradedFixture);
    const prosumer = connectContracts(deployment, prosumerWallet);
    await prosumer.market.cancelListing(1); // 400 Wh back to P2's wallet
    await prosumer.token.transfer(ethers.Wallet.createRandom().address, 150);
    const report = await buildSettlement(deployment, ethers.provider);
    expect(report.checks.filter((c) => !c.ok)).to.deep.equal([]);
    expect(report.checks.find((c) => c.name === "Supply = wallets + marketplace escrow")!.detail).to.include("0.15 kWh in 1 other wallets");
  });

  it("flags mUSD issued after deployment funding, even though participants hold all of it", async () => {
    const { deployment, admin, consumerWallet } = await loadFixture(tradedFixture);
    await connectContracts(deployment, admin).stable.mint(consumerWallet.address, 1000n * USD);
    const report = await buildSettlement(deployment, ethers.provider);
    const check = report.checks.find((c) => c.name.startsWith("Stablecoin conserved"))!;
    expect(check.ok).to.equal(false);
    expect(check.detail).to.include("1 balances differ");
  });
});
