import type { EnergyMarketplace, EnergyToken, MockStablecoin } from "../../typechain-types";
import { revertName } from "../shared/chain";
import { TARIFFS, type ParticipantSpec } from "../shared/participants";
import { INTERVAL_SECONDS } from "../shared/reading";
import { quote, usdPerKwh } from "../shared/units";
import { expectedLoadKw } from "../meter-simulator/physics";

/**
 * Simple rule-based trading bots standing in for the households' wallets.
 * They use nothing but public chain state and their own wallet.
 */

export interface MarketEvent {
  kind: "listed" | "repriced" | "cancelled" | "bought" | "buy-failed";
  who: string;
  listingId: bigint;
  amountWh?: bigint;
  pricePerKwh?: bigint;
  cost?: bigint;
  detail?: string;
}

export interface OpenListing {
  id: bigint;
  seller: string;
  remainingWh: bigint;
  pricePerKwh: bigint;
}

/** Off-chain view of open listings, rebuilt from events (the contract never loops over listings). */
export class OrderBook {
  private readonly open = new Map<bigint, OpenListing>();
  private nextBlock = 0;

  constructor(private readonly market: EnergyMarketplace) {}

  async sync(): Promise<void> {
    const latest = await this.market.runner!.provider!.getBlockNumber();
    if (latest >= this.nextBlock) {
      const created = await this.market.queryFilter(this.market.filters.ListingCreated(), this.nextBlock, latest);
      for (const ev of created) {
        const { listingId, seller } = ev.args;
        this.open.set(listingId, { id: listingId, seller, remainingWh: 0n, pricePerKwh: 0n });
      }
      this.nextBlock = latest + 1;
    }
    for (const [id, l] of this.open) {
      const onchain = await this.market.getListing(id);
      if (!onchain.active) this.open.delete(id);
      else Object.assign(l, { remainingWh: onchain.remainingWh, pricePerKwh: onchain.pricePerKwh });
    }
  }

  /** Cheapest first, then oldest first. */
  listings(): OpenListing[] {
    return [...this.open.values()].sort((a, b) =>
      a.pricePerKwh === b.pricePerKwh ? Number(a.id - b.id) : a.pricePerKwh < b.pricePerKwh ? -1 : 1,
    );
  }
}

/** Only list once at least this much new energy has been credited. */
const MIN_LISTING_WH = 1000n;
/** A listing still open this long after it was listed or last discounted is discounted by 10% (checked on the hour). */
const REPRICE_AFTER_SECONDS = 2 * 3600;
const REPRICE_FACTOR_BPS = 9000n;

/**
 * Prosumer: offers newly minted credits at its ask price, discounts listings
 * that don't sell, and withdraws them (keeping the credits for its own
 * evening consumption) rather than sell below its floor.
 */
export class ProsumerAgent {
  private pendingWh = 0n;
  private nextMintBlock = 0;
  private readonly lastPriced = new Map<bigint, number>(); // listingId -> time of last (re)price

  constructor(
    readonly spec: ParticipantSpec,
    readonly address: string,
    private readonly token: EnergyToken,
    private readonly market: EnergyMarketplace,
  ) {}

  async approve(): Promise<void> {
    await (await this.token.approve(await this.market.getAddress(), 2n ** 256n - 1n)).wait();
  }

  async act(now: number, isTopOfHour: boolean): Promise<MarketEvent[]> {
    const events: MarketEvent[] = [];
    if (isTopOfHour) events.push(...(await this.reprice(now)));

    // New credits minted to this household since the last check.
    const latest = await this.token.runner!.provider!.getBlockNumber();
    const minted = await this.token.queryFilter(this.token.filters.CreditsMinted(this.address), this.nextMintBlock, latest);
    this.nextMintBlock = latest + 1;
    for (const ev of minted) this.pendingWh += ev.args.amountWh;

    if (this.pendingWh >= MIN_LISTING_WH) {
      const balance = await this.token.balanceOf(this.address);
      const amountWh = this.pendingWh < balance ? this.pendingWh : balance;
      this.pendingWh = 0n;
      if (amountWh > 0n) {
        const price = usdPerKwh(this.spec.askUsdPerKwh!);
        const receipt = (await (await this.market.createListing(amountWh, price)).wait())!;
        const listingId = this.listingIdFrom(receipt.logs);
        this.lastPriced.set(listingId, now);
        events.push({ kind: "listed", who: this.spec.id, listingId, amountWh, pricePerKwh: price });
      }
    }
    return events;
  }

  private async reprice(now: number): Promise<MarketEvent[]> {
    const events: MarketEvent[] = [];
    const floor = usdPerKwh(TARIFFS.prosumerFloorUsdPerKwh);
    for (const [id, pricedAt] of this.lastPriced) {
      const l = await this.market.getListing(id);
      if (!l.active) {
        this.lastPriced.delete(id);
        continue;
      }
      if (now - pricedAt < REPRICE_AFTER_SECONDS) continue;
      const discounted = (l.pricePerKwh * REPRICE_FACTOR_BPS) / 10_000n;
      if (discounted < floor) {
        await (await this.market.cancelListing(id)).wait();
        this.lastPriced.delete(id);
        events.push({ kind: "cancelled", who: this.spec.id, listingId: id, amountWh: l.remainingWh, detail: "below floor price" });
      } else {
        await (await this.market.updatePrice(id, discounted)).wait();
        this.lastPriced.set(id, now);
        events.push({ kind: "repriced", who: this.spec.id, listingId: id, pricePerKwh: discounted });
      }
    }
    return events;
  }

  private listingIdFrom(logs: readonly { topics: readonly string[]; data: string }[]): bigint {
    for (const log of logs) {
      const parsed = this.market.interface.parseLog(log);
      if (parsed?.name === "ListingCreated") return parsed.args.listingId as bigint;
    }
    throw new Error("ListingCreated event not found");
  }
}

/** Plan purchases to cover this many hours of expected consumption. */
const LOOKAHEAD_HOURS = 4;
const MIN_PURCHASE_WH = 200n;

/**
 * Consumer: keeps enough credits to cover its expected consumption for the
 * next few hours, buying the cheapest listings under its price limit. It passes
 * the price it saw as `maxPricePerKwh`, so a seller cannot re-price the order
 * out from under it.
 */
export class ConsumerAgent {
  constructor(
    readonly spec: ParticipantSpec,
    readonly address: string,
    private readonly token: EnergyToken,
    private readonly stable: MockStablecoin,
    private readonly market: EnergyMarketplace,
    private readonly dayStart: number,
  ) {}

  async approve(): Promise<void> {
    await (await this.stable.approve(await this.market.getAddress(), 2n ** 256n - 1n)).wait();
  }

  /** Expected consumption (Wh) over the next LOOKAHEAD_HOURS from `now`. */
  expectedNeedWh(now: number): bigint {
    let wh = 0;
    for (let t = now; t < now + LOOKAHEAD_HOURS * 3600; t += INTERVAL_SECONDS) {
      const hour = (((t - this.dayStart) / 3600) % 24) + 0.125;
      wh += expectedLoadKw(this.spec, hour) * 250;
    }
    return BigInt(Math.round(wh));
  }

  async act(now: number, book: OrderBook): Promise<MarketEvent[]> {
    const events: MarketEvent[] = [];
    const maxPrice = usdPerKwh(this.spec.maxUsdPerKwh!);
    let need = this.expectedNeedWh(now) - (await this.token.balanceOf(this.address));
    if (need < MIN_PURCHASE_WH) return events;
    let cash = await this.stable.balanceOf(this.address);

    for (const l of book.listings()) {
      if (need < MIN_PURCHASE_WH) break;
      if (l.pricePerKwh > maxPrice) break; // sorted by price: nothing cheaper follows
      if (l.seller === this.address || l.remainingWh === 0n) continue;

      let amountWh = need < l.remainingWh ? need : l.remainingWh;
      const affordableWh = (cash * 1000n) / l.pricePerKwh;
      if (affordableWh < amountWh) amountWh = affordableWh;
      if (amountWh === 0n) break;

      try {
        const cost = quote(l.pricePerKwh, amountWh);
        await (await this.market.buy(l.id, amountWh, l.pricePerKwh)).wait();
        l.remainingWh -= amountWh;
        need -= amountWh;
        cash -= cost;
        events.push({ kind: "bought", who: this.spec.id, listingId: l.id, amountWh, pricePerKwh: l.pricePerKwh, cost });
      } catch (err) {
        events.push({ kind: "buy-failed", who: this.spec.id, listingId: l.id, detail: revertName(err, this.market.interface) });
      }
    }
    return events;
  }
}
