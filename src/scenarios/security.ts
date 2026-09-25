import { Wallet, type BaseWallet, type JsonRpcProvider, type TypedDataDomain } from "ethers";
import type { OrderBook } from "../market/agents";
import { sendToOracle, type OracleResponse } from "../meter-simulator/meter";
import type { NeighbourhoodSimulator } from "../meter-simulator/simulator";
import { revertName, type Contracts, type Deployment } from "../shared/chain";
import { signReading, type SignedReading } from "../shared/reading";
import { formatUsd, hhmm } from "../shared/units";

/**
 * Attacks and failure modes injected into the simulated day. Each one is
 * attempted for real against the running oracle and contracts, and the
 * outcome is reported (and shown on the dashboard).
 */

export interface ScenarioStep {
  action: string;
  result: string;
  blocked: boolean; // true = the system behaved safely
}

export interface ScenarioOutcome {
  at: number; // chain time
  title: string;
  threat: string;
  steps: ScenarioStep[];
}

export interface ScenarioContext {
  deployment: Deployment;
  domain: TypedDataDomain;
  provider: JsonRpcProvider;
  oracleUrl: string;
  sim: NeighbourhoodSimulator;
  book: OrderBook;
  /** Contracts connected to the admin (registrar + pauser). */
  admin: Contracts;
  /** Contracts connected to the oracle's key, as an attacker who stole it would use them. */
  oracleKey: Contracts;
  /** An arbitrary outside account. */
  attacker: { wallet: BaseWallet; contracts: Contracts };
  /** Wallet-connected contracts per participant id. */
  participants: Map<string, { wallet: BaseWallet; contracts: Contracts }>;
  /** Last reading the oracle settled for each participant. */
  lastSettled: Map<string, SignedReading>;
  /** Drain the oracle queue (after unpausing). */
  drainOracle: () => Promise<number>;
}

export type Phase = "before-readings" | "after-readings";

export interface ScenarioHook {
  interval: number; // 0..95
  phase: Phase;
  run: (ctx: ScenarioContext, intervalStart: number) => Promise<ScenarioOutcome | null>;
}

const EXPECT = (res: OracleResponse, code: string): ScenarioStep["blocked"] => res.status === "rejected" && res.code === code;
const describe = (res: OracleResponse) => (res.status === "rejected" ? `oracle rejected: ${res.code} (${res.detail})` : `oracle ${res.status}`);

async function onchainAttempt(action: string, expected: string, call: () => Promise<unknown>, iface: Contracts["token"]["interface"]): Promise<ScenarioStep> {
  try {
    await call();
    return { action, result: "call SUCCEEDED — this should not happen", blocked: false };
  } catch (err) {
    const name = revertName(err, iface);
    return { action, result: `contract reverted: ${name}`, blocked: name === expected };
  }
}

const meterOf = (ctx: ScenarioContext, id: string) => ctx.deployment.participants.find((p) => p.id === id)!;

export const SCENARIOS: ScenarioHook[] = [
  // 09:00 — someone without the meter's key tries to claim its production.
  {
    interval: 36,
    phase: "before-readings",
    run: async (ctx, t) => {
      const victim = meterOf(ctx, "P1");
      const forger = Wallet.createRandom();
      const reading = { meter: victim.meter, intervalStart: t, exportedWh: victim.maxExportWh, importedWh: 0, nonce: 10_000 };
      const forged = await sendToOracle(ctx.oracleUrl, { reading, signature: await signReading(forger, ctx.domain, reading) });

      const rogueMeter = Wallet.createRandom();
      const rogueReading = { meter: rogueMeter.address, intervalStart: t, exportedWh: 1000, importedWh: 0, nonce: 1 };
      const rogue = await sendToOracle(ctx.oracleUrl, {
        reading: rogueReading,
        signature: await signReading(rogueMeter, ctx.domain, rogueReading),
      });
      return {
        at: t,
        title: "Spoofed meter",
        threat: "An attacker fabricates readings to mint credits they did not produce.",
        steps: [
          { action: `Reading claiming to be P1's meter, signed with the attacker's key`, result: describe(forged), blocked: EXPECT(forged, "BAD_SIGNATURE") },
          { action: "Reading from a meter the utility never registered", result: describe(rogue), blocked: EXPECT(rogue, "UNKNOWN_METER") },
        ],
      };
    },
  },

  // 09:30 — the same energy submitted twice.
  {
    interval: 38,
    phase: "after-readings",
    run: async (ctx, t) => {
      const settled = ctx.lastSettled.get("P2");
      if (!settled) return null;
      const replay = await sendToOracle(ctx.oracleUrl, settled);
      const resigned = await ctx.sim.meters.get("P2")!.sign({
        intervalStart: settled.reading.intervalStart,
        exportedWh: settled.reading.exportedWh,
        importedWh: settled.reading.importedWh,
      });
      const again = await sendToOracle(ctx.oracleUrl, resigned);
      return {
        at: t,
        title: "Replay and double counting",
        threat: "A captured reading is re-sent, or the same interval is re-signed with a fresh nonce, to mint twice.",
        steps: [
          { action: `Re-send P2's settled ${hhmm(settled.reading.intervalStart)} reading byte-for-byte`, result: describe(replay), blocked: EXPECT(replay, "DUPLICATE") },
          { action: `P2's meter re-signs the ${hhmm(settled.reading.intervalStart)} interval with a new nonce`, result: describe(again), blocked: EXPECT(again, "INTERVAL_ALREADY_SETTLED") },
        ],
      };
    },
  },

  // 10:00 — a faulty or tampered meter reports more than the panels can produce.
  {
    interval: 40,
    phase: "before-readings",
    run: async (ctx, t) => {
      const p4 = meterOf(ctx, "P4");
      const inflated = await ctx.sim.meters.get("P4")!.sign({ intervalStart: t, exportedWh: p4.maxExportWh * 3, importedWh: 0 });
      const res = await sendToOracle(ctx.oracleUrl, inflated);
      return {
        at: t,
        title: "Implausible production",
        threat: "A malfunctioning or tampered meter reports export above the system's rated capacity.",
        steps: [
          {
            action: `P4's own meter signs ${(p4.maxExportWh * 3) / 1000} kWh for 15 min (rated max ${p4.maxExportWh / 1000} kWh)`,
            result: describe(res),
            blocked: EXPECT(res, "EXPORT_ABOVE_CAPACITY"),
          },
        ],
      };
    },
  },

  // 11:00 — the oracle's key is stolen and used directly against the contract.
  // Runs before the 11:00 readings so P1's interval is still open: only the
  // meter signature stands between the attacker and a mint.
  {
    interval: 44,
    phase: "before-readings",
    run: async (ctx, t) => {
      const { token } = ctx.oracleKey;
      const iface = token.interface;
      const p1 = meterOf(ctx, "P1");
      const forgedReading = { meter: p1.meter, intervalStart: t, exportedWh: p1.maxExportWh, importedWh: 0, nonce: 50_000 };
      const forgedSig = await signReading(Wallet.createRandom(), ctx.domain, forgedReading);
      const p3 = ctx.lastSettled.get("P3");
      const steps = [
        await onchainAttempt(
          "Stolen oracle key mints for P1 with a forged meter signature",
          "InvalidMeterSignature",
          () => token.submitReading.staticCall(forgedReading, forgedSig),
          iface,
        ),
      ];
      if (p3) {
        steps.push(
          await onchainAttempt(
            `Stolen oracle key replays P3's settled ${hhmm(p3.reading.intervalStart)} reading`,
            "IntervalAlreadySettled",
            () => token.submitReading.staticCall(p3.reading, p3.signature),
            iface,
          ),
        );
      }
      steps.push(
        await onchainAttempt(
          "Stolen oracle key registers a fake meter it controls",
          "AccessControlUnauthorizedAccount",
          () => token.registerMeter.staticCall(Wallet.createRandom().address, ctx.attacker.wallet.address, 5000, 5000),
          iface,
        ),
        await onchainAttempt(
          "An account without ORACLE_ROLE submits a reading",
          "AccessControlUnauthorizedAccount",
          () => ctx.attacker.contracts.token.submitReading.staticCall(forgedReading, forgedSig),
          iface,
        ),
      );
      return {
        at: t,
        title: "Compromised oracle",
        threat: "The oracle's signing key leaks. Can it mint arbitrary credits?",
        steps,
      };
    },
  },

  // 12:00 — a seller front-runs a pending buy by raising the price.
  {
    interval: 48,
    phase: "after-readings",
    run: async (ctx, t) => {
      await ctx.book.sync();
      const buyerId = "C3";
      const buyer = ctx.participants.get(buyerId)!;
      const listing = ctx.book.listings().find((l) => l.remainingWh >= 200n);
      const threat = "A seller watches the mempool and raises the price before a pending buy is mined.";
      if (!listing) {
        return { at: t, title: "Front-running", threat, steps: [{ action: "No open listing to target", result: "skipped", blocked: true }] };
      }
      const seller = [...ctx.participants.entries()].find(([, p]) => p.wallet.address === listing.seller)!;
      const amountWh = listing.remainingWh < 500n ? listing.remainingWh : 500n;
      const cashBefore = await buyer.contracts.stable.balanceOf(buyer.wallet.address);
      const gwei = 1_000_000_000n;

      // Hold mining so both transactions sit in the mempool together, as on a public chain.
      await ctx.provider.send("evm_setAutomine", [false]);
      let buyTx, repriceTx;
      try {
        buyTx = await buyer.contracts.market.buy(listing.id, amountWh, listing.pricePerKwh, {
          gasLimit: 300_000,
          maxFeePerGas: 100n * gwei,
          maxPriorityFeePerGas: 1n * gwei,
        });
        // The seller sees the pending buy and outbids it with a higher tip.
        repriceTx = await seller[1].contracts.market.updatePrice(listing.id, listing.pricePerKwh * 2n, {
          gasLimit: 100_000,
          maxFeePerGas: 100n * gwei,
          maxPriorityFeePerGas: 5n * gwei,
        });
        await ctx.provider.send("evm_mine", []);
      } finally {
        await ctx.provider.send("evm_setAutomine", [true]);
      }
      const repriceReceipt = await ctx.provider.getTransactionReceipt(repriceTx!.hash);
      const buyReceipt = await ctx.provider.getTransactionReceipt(buyTx!.hash);
      const reason = await buyer.contracts.market.buy
        .staticCall(listing.id, amountWh, listing.pricePerKwh)
        .then(() => "none")
        .catch((err) => revertName(err, buyer.contracts.market.interface));
      const cashAfter = await buyer.contracts.stable.balanceOf(buyer.wallet.address);
      const sameBlock = repriceReceipt?.blockNumber === buyReceipt?.blockNumber;
      const orderedFirst = (repriceReceipt?.index ?? 99) < (buyReceipt?.index ?? 0);

      return {
        at: t,
        title: "Front-running",
        threat,
        steps: [
          {
            action: `${buyerId} submits buy of ${Number(amountWh) / 1000} kWh from listing #${listing.id} at $${formatUsd(listing.pricePerKwh, 3)}/kWh (tip 1 gwei)`,
            result: "pending in mempool",
            blocked: true,
          },
          {
            action: `${seller[0]} re-prices listing #${listing.id} to $${formatUsd(listing.pricePerKwh * 2n, 3)}/kWh with a 5 gwei tip`,
            result: sameBlock && orderedFirst ? "mined first in the same block" : "mined",
            blocked: true,
          },
          {
            action: `${buyerId}'s buy executes after the price change`,
            result:
              buyReceipt?.status === 0
                ? `reverted (${reason}); buyer paid $${formatUsd(cashBefore - cashAfter)} — maxPricePerKwh protected the order`
                : "FILLED at the higher price — this should not happen",
            blocked: buyReceipt?.status === 0 && cashAfter === cashBefore,
          },
        ],
      };
    },
  },

  // 13:00 — emergency stop, then 13:15 — resume.
  {
    interval: 52,
    phase: "before-readings",
    run: async (ctx, t) => {
      await (await ctx.admin.token.pause()).wait();
      return {
        at: t,
        title: "Emergency pause",
        threat: "Operator halts minting, burning and transfers (e.g. while investigating an incident).",
        steps: [{ action: "Admin (PAUSER_ROLE) pauses EnergyToken", result: "paused: readings will queue at the oracle, trading halts", blocked: true }],
      };
    },
  },
  {
    interval: 52,
    phase: "after-readings",
    run: async (ctx, t) => {
      const status = (await (await fetch(`${ctx.oracleUrl}/status`)).json()) as { stats: { queued: number } };
      return {
        at: t,
        title: "Emergency pause",
        threat: "",
        steps: [
          {
            action: `Meters report the ${hhmm(t)}–${hhmm(t + 900)} interval while paused`,
            result: `${status.stats.queued} readings held in the oracle's queue, none lost`,
            blocked: status.stats.queued > 0,
          },
        ],
      };
    },
  },
  {
    interval: 53,
    phase: "before-readings",
    run: async (ctx, t) => {
      await (await ctx.admin.token.unpause()).wait();
      const settled = await ctx.drainOracle();
      return {
        at: t,
        title: "Emergency pause",
        threat: "",
        steps: [{ action: "Admin unpauses EnergyToken", result: `oracle drained its queue: ${settled} readings settled in order`, blocked: settled > 0 }],
      };
    },
  },
];
