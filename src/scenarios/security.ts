import { Wallet, type BaseWallet, type Interface, type JsonRpcProvider, type TypedDataDomain } from "ethers";
import type { OrderBook } from "../market/agents";
import { sendToOracle, type OracleResponse } from "../meter-simulator/meter";
import type { NeighbourhoodSimulator } from "../meter-simulator/simulator";
import { revertName, type Contracts, type Deployment } from "../shared/chain";
import { PARTICIPANTS } from "../shared/participants";
import { INTERVAL_SECONDS, signReading, type SignedReading } from "../shared/reading";
import { formatUsd, hhmm, usdPerKwh } from "../shared/units";

/**
 * Attacks and failure modes injected into the simulated day. Each one is
 * attempted for real against the running oracle and contracts, and the
 * outcome is reported (and shown on the dashboard).
 */

export interface ScenarioStep {
  action: string;
  result: string;
  blocked: boolean; // true = the attack was attempted and the system behaved safely
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
  run: (ctx: ScenarioContext, intervalStart: number) => Promise<ScenarioOutcome>;
}

const EXPECT = (res: OracleResponse, code: string): ScenarioStep["blocked"] => res.status === "rejected" && res.code === code;
const describe = (res: OracleResponse) => (res.status === "rejected" ? `oracle rejected: ${res.code} (${res.detail})` : `oracle ${res.status}`);

/** A step that could not be set up. It proves nothing, so it counts as a failure rather than a pass. */
const notRun = (action: string, why: string): ScenarioStep => ({ action, result: `NOT RUN: ${why}`, blocked: false });

async function onchainAttempt(action: string, expected: string, call: () => Promise<unknown>, iface: Interface): Promise<ScenarioStep> {
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
      const title = "Replay and double counting";
      const threat = "A captured reading is re-sent, or the same interval is re-signed with a fresh nonce, to mint twice.";
      const settled = ctx.lastSettled.get("P2");
      if (!settled) return { at: t, title, threat, steps: [notRun("Replay P2's last settled reading", "P2 has no settled reading yet")] };
      const replay = await sendToOracle(ctx.oracleUrl, settled);
      const resigned = await ctx.sim.meters.get("P2")!.sign({
        intervalStart: settled.reading.intervalStart,
        exportedWh: settled.reading.exportedWh,
        importedWh: settled.reading.importedWh,
      });
      const again = await sendToOracle(ctx.oracleUrl, resigned);
      return {
        at: t,
        title,
        threat,
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
      steps.push(
        p3
          ? await onchainAttempt(
              `Stolen oracle key replays P3's settled ${hhmm(p3.reading.intervalStart)} reading`,
              "IntervalAlreadySettled",
              () => token.submitReading.staticCall(p3.reading, p3.signature),
              iface,
            )
          : notRun("Stolen oracle key replays P3's last settled reading", "P3 has no settled reading yet"),
      );
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
      const title = "Front-running";
      const threat = "A seller watches the mempool and raises the price before a pending buy is mined.";
      // The attacking seller has to be a household this demo controls; anyone else's listing is skipped.
      const sellerOf = (l: { seller: string }) => [...ctx.participants.entries()].find(([, p]) => p.wallet.address === l.seller);
      let listing = ctx.book.listings().find((l) => l.remainingWh >= 200n && sellerOf(l));
      let seller = listing && sellerOf(listing);
      const setup: ScenarioStep[] = [];

      if (!listing || !seller) {
        // Nothing suitable on the book (e.g. on a winter day every listing sells at once), so
        // the prosumer holding the most unlisted credits lists some for the attack to target.
        const balances = await Promise.all(
          PARTICIPANTS.filter((p) => p.role === "prosumer").map(async (p) => {
            const who = ctx.participants.get(p.id)!;
            return { spec: p, who, balance: await who.contracts.token.balanceOf(who.wallet.address) };
          }),
        );
        const richest = balances.sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0))[0];
        if (!richest || richest.balance < 200n) {
          return { at: t, title, threat, steps: [notRun("Find a listing to front-run", "no open listing and no prosumer holds 200 Wh of credits")] };
        }
        const amount = richest.balance < 500n ? richest.balance : 500n;
        const price = usdPerKwh(richest.spec.askUsdPerKwh!);
        const receipt = (await (await richest.who.contracts.market.createListing(amount, price)).wait())!;
        const created = receipt.logs.map((l) => richest.who.contracts.market.interface.parseLog(l)).find((e) => e?.name === "ListingCreated")!;
        listing = { id: created.args.listingId as bigint, seller: richest.who.wallet.address, remainingWh: amount, pricePerKwh: price };
        seller = [richest.spec.id, richest.who];
        setup.push({
          action: `No open listing to target, so ${richest.spec.id} lists ${Number(amount) / 1000} kWh at $${formatUsd(price, 3)}/kWh for the attack`,
          result: `listing #${listing.id} created`,
          blocked: true,
        });
      }
      const target = listing;
      const amountWh = target.remainingWh < 500n ? target.remainingWh : 500n;
      const cashBefore = await buyer.contracts.stable.balanceOf(buyer.wallet.address);
      const gwei = 1_000_000_000n;

      const sellerMarket = seller[1].contracts.market;

      // Hold mining so both transactions sit in the mempool together, as on a public chain.
      await ctx.provider.send("evm_setAutomine", [false]);
      let buyTx, repriceTx;
      try {
        buyTx = await buyer.contracts.market.buy(target.id, amountWh, target.pricePerKwh, {
          gasLimit: 300_000,
          maxFeePerGas: 100n * gwei,
          maxPriorityFeePerGas: 1n * gwei,
        });
        // The seller sees the pending buy and outbids it with a higher tip.
        repriceTx = await sellerMarket.updatePrice(target.id, target.pricePerKwh * 2n, {
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
      const sameBlock = repriceReceipt !== null && repriceReceipt.blockNumber === buyReceipt?.blockNumber;
      const orderedFirst = sameBlock && repriceReceipt.index < buyReceipt!.index;
      // With both in one block and the re-price first, the state after the block is the
      // state the buy executed against, so re-running it reproduces its revert reason.
      const reason = await buyer.contracts.market.buy
        .staticCall(target.id, amountWh, target.pricePerKwh)
        .then(() => "none")
        .catch((err) => revertName(err, buyer.contracts.market.interface));
      const cashAfter = await buyer.contracts.stable.balanceOf(buyer.wallet.address);
      const paid = `buyer paid $${formatUsd(cashBefore - cashAfter)}`;
      const outcome =
        buyReceipt === null
          ? "the buy was not mined"
          : buyReceipt.status === 1
            ? orderedFirst
              ? `FILLED at the higher price; ${paid} — this should not happen`
              : `filled before the price change; ${paid}`
            : reason === "PriceAboveLimit"
              ? `reverted (${reason}); ${paid} — maxPricePerKwh protected the order`
              : `reverted (${reason}), not because of maxPricePerKwh; ${paid}`;

      // Put the market back as it was, so the attack does not distort the rest of the day
      // (unless the buy emptied the listing, which the steps below report as a failure).
      const live = await sellerMarket.getListing(target.id);
      if (live.active && setup.length > 0) await (await sellerMarket.cancelListing(target.id)).wait();
      else if (live.active && live.pricePerKwh !== target.pricePerKwh) {
        await (await sellerMarket.updatePrice(target.id, target.pricePerKwh)).wait();
      }

      return {
        at: t,
        title,
        threat,
        steps: [
          ...setup,
          {
            action: `${buyerId} submits buy of ${Number(amountWh) / 1000} kWh from listing #${target.id} at $${formatUsd(target.pricePerKwh, 3)}/kWh (tip 1 gwei)`,
            result: "pending in mempool",
            blocked: true,
          },
          {
            action: `${seller[0]} re-prices listing #${target.id} to $${formatUsd(target.pricePerKwh * 2n, 3)}/kWh with a 5 gwei tip`,
            result: orderedFirst ? "mined first in the same block" : "NOT mined ahead of the buy in the same block, so the race was not set up",
            blocked: orderedFirst,
          },
          {
            action: `${buyerId}'s buy executes after the price change`,
            result: outcome,
            blocked: orderedFirst && buyReceipt?.status === 0 && reason === "PriceAboveLimit" && cashAfter === cashBefore,
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
      const p1 = ctx.participants.get("P1")!.contracts.market;
      return {
        at: t,
        title: "Emergency pause",
        threat: "Operator halts minting, burning and transfers (e.g. while investigating an incident).",
        steps: [
          { action: "Admin (PAUSER_ROLE) pauses EnergyToken", result: "paused: readings will queue at the oracle", blocked: true },
          await onchainAttempt(
            "P1 tries to list credits on the marketplace while the token is paused",
            "EnforcedPause",
            () => p1.createListing.staticCall(100n, usdPerKwh(0.14)),
            p1.interface,
          ),
        ],
      };
    },
  },
  {
    interval: 52,
    phase: "after-readings",
    run: async (ctx, t) => {
      const status = (await (await fetch(`${ctx.oracleUrl}/status`)).json()) as { stats: { queued: number } };
      const meters = ctx.deployment.participants.length;
      return {
        at: t,
        title: "Emergency pause",
        threat: "",
        steps: [
          {
            action: `Meters report the ${hhmm(t)}–${hhmm(t + INTERVAL_SECONDS)} interval while paused`,
            result: `${status.stats.queued} of ${meters} readings held in the oracle's queue`,
            blocked: status.stats.queued === meters,
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
      const paused = t - INTERVAL_SECONDS;
      const cursors = await Promise.all(ctx.deployment.participants.map((p) => ctx.admin.token.getMeter(p.meter)));
      const caughtUp = cursors.filter((m) => Number(m.lastIntervalStart) === paused).length;
      return {
        at: t,
        title: "Emergency pause",
        threat: "",
        steps: [
          {
            action: "Admin unpauses EnergyToken",
            result: `oracle drained its queue: ${settled} readings settled; ${caughtUp} of ${cursors.length} meters now settled through ${hhmm(paused)}`,
            blocked: settled === cursors.length && caughtUp === cursors.length,
          },
        ],
      };
    },
  },
];
