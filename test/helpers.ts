import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { Wallet, type TypedDataDomain } from "ethers";
import type { EnergyToken } from "../typechain-types";
import { INTERVAL_SECONDS, readingDomain, signReading, type MeterReading } from "../src/shared/reading";

export const MAX_EXPORT_WH = 1500; // 6 kW PV for 15 minutes
export const MAX_IMPORT_WH = 6000; // 24 kW service for 15 minutes

/**
 * A simulated meter: its own key plus a nonce counter, like the off-chain SmartMeter.
 * The counter only ever grows, so it stays valid when loadFixture reverts the
 * chain to an earlier snapshot (the contract accepts gaps, not repeats).
 */
export class TestMeter {
  readonly wallet = Wallet.createRandom();
  nonce = 0;
  constructor(readonly domain: TypedDataDomain) {}

  get address(): string {
    return this.wallet.address;
  }

  async sign(fields: Partial<MeterReading> & { intervalStart: number }): Promise<{ reading: MeterReading; signature: string }> {
    const reading: MeterReading = {
      meter: this.address,
      exportedWh: 0,
      importedWh: 0,
      nonce: ++this.nonce,
      ...fields,
    };
    return { reading, signature: await signReading(this.wallet, this.domain, reading) };
  }
}

export async function domainFor(token: EnergyToken): Promise<TypedDataDomain> {
  const { chainId } = await ethers.provider.getNetwork();
  return readingDomain(chainId, await token.getAddress());
}

/** Start of the most recent 15-minute interval that has fully finished. */
export async function lastFinishedInterval(): Promise<number> {
  const now = await time.latest();
  return Math.floor(now / INTERVAL_SECONDS) * INTERVAL_SECONDS - INTERVAL_SECONDS;
}

/** Move the chain clock forward by `n` intervals. */
export async function advanceIntervals(n = 1): Promise<void> {
  await time.increase(n * INTERVAL_SECONDS);
}
