import fs from "node:fs";
import path from "node:path";
import type { Provider } from "ethers";
import { REPORTS_DIR, connectContracts, type Deployment } from "../shared/chain";
import { TARIFFS } from "../shared/participants";
import { hhmm } from "../shared/units";

/**
 * Settlement report for the simulated period, built from on-chain events only
 * (plus optional simulator telemetry for behind-the-meter PV and load, which
 * the chain never sees).
 */

export interface Telemetry {
  [participantId: string]: { pvWh: number; loadWh: number };
}

export interface ParticipantSettlement {
  id: string;
  role: "prosumer" | "consumer";
  label: string;
  wallet: string;
  pvGeneratedKwh: number | null; // simulated, behind the meter
  loadKwh: number | null; // simulated, behind the meter
  exportedKwh: number; // verified meter readings = credits minted
  importedKwh: number; // verified meter readings
  creditsBurnedKwh: number; // imported energy covered by credits
  gridSuppliedKwh: number; // imported energy not covered by credits (utility tariff)
  listedKwh: number;
  soldKwh: number;
  revenueUsd: number;
  avgSaleUsdPerKwh: number | null;
  boughtKwh: number;
  spentUsd: number;
  avgBuyUsdPerKwh: number | null;
  creditsInWalletKwh: number;
  creditsInOpenListingsKwh: number;
  stablecoinUsd: number;
  /** Prosumer: revenue minus what the same energy earns at the utility feed-in tariff. */
  upliftVsFeedInUsd: number;
  /** Consumer: what the bought energy would cost at grid retail minus what was paid. */
  savingsVsGridUsd: number;
}

export interface IntegrityCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SettlementReport {
  simDate: string;
  period: { from: number | null; to: number | null };
  counts: { readings: number; listings: number; trades: number; cancellations: number };
  participants: ParticipantSettlement[];
  totals: {
    exportedKwh: number;
    importedKwh: number;
    mintedKwh: number;
    burnedKwh: number;
    tradedKwh: number;
    tradedUsd: number;
    avgTradeUsdPerKwh: number | null;
    creditsOutstandingKwh: number;
  };
  checks: IntegrityCheck[];
  tariffs: typeof TARIFFS;
}

const kwh = (wh: bigint) => Number(wh) / 1000;
const usd = (units: bigint) => Number(units) / 1e6;

export async function buildSettlement(
  deployment: Deployment,
  provider: Provider,
  telemetry?: Telemetry,
): Promise<SettlementReport> {
  const { token, market, stable } = connectContracts(deployment, provider);
  const [readings, minted, burned, created, trades, cancelled] = await Promise.all([
    token.queryFilter(token.filters.ReadingSettled()),
    token.queryFilter(token.filters.CreditsMinted()),
    token.queryFilter(token.filters.CreditsBurned()),
    market.queryFilter(market.filters.ListingCreated()),
    market.queryFilter(market.filters.Trade()),
    market.queryFilter(market.filters.ListingCancelled()),
  ]);

  type Acc = Record<
    "exported" | "imported" | "minted" | "burned" | "listed" | "sold" | "revenue" | "bought" | "spent" | "escrow",
    bigint
  >;
  const acc = new Map<string, Acc>();
  const byWallet = (w: string) => {
    const key = w.toLowerCase();
    if (!acc.has(key)) {
      acc.set(key, { exported: 0n, imported: 0n, minted: 0n, burned: 0n, listed: 0n, sold: 0n, revenue: 0n, bought: 0n, spent: 0n, escrow: 0n });
    }
    return acc.get(key)!;
  };

  const seenIntervals = new Set<string>();
  let duplicateIntervals = 0;
  let exportedTotal = 0n;
  for (const ev of readings) {
    const a = byWallet(ev.args.owner);
    a.exported += ev.args.exportedWh;
    a.imported += ev.args.importedWh;
    exportedTotal += ev.args.exportedWh;
    const key = `${ev.args.meter}:${ev.args.intervalStart}`;
    if (seenIntervals.has(key)) duplicateIntervals++;
    seenIntervals.add(key);
  }
  let mintedTotal = 0n;
  for (const ev of minted) {
    byWallet(ev.args.owner).minted += ev.args.amountWh;
    mintedTotal += ev.args.amountWh;
  }
  let burnedTotal = 0n;
  for (const ev of burned) {
    byWallet(ev.args.owner).burned += ev.args.amountWh;
    burnedTotal += ev.args.amountWh;
  }
  for (const ev of created) byWallet(ev.args.seller).listed += ev.args.amountWh;
  let tradedWh = 0n;
  let tradedUnits = 0n;
  for (const ev of trades) {
    const s = byWallet(ev.args.seller);
    const b = byWallet(ev.args.buyer);
    s.sold += ev.args.amountWh;
    s.revenue += ev.args.cost;
    b.bought += ev.args.amountWh;
    b.spent += ev.args.cost;
    tradedWh += ev.args.amountWh;
    tradedUnits += ev.args.cost;
  }

  // Credits still in escrow, per seller (only listings that are still open).
  let escrowTotal = 0n;
  for (const ev of created) {
    const l = await market.getListing(ev.args.listingId);
    if (l.active) {
      byWallet(l.seller).escrow += l.remainingWh;
      escrowTotal += l.remainingWh;
    }
  }

  const participants: ParticipantSettlement[] = [];
  let walletCreditsTotal = 0n;
  let stableTotal = 0n;
  for (const p of deployment.participants) {
    const a = byWallet(p.wallet);
    const [walletCredits, stableBalance] = await Promise.all([token.balanceOf(p.wallet), stable.balanceOf(p.wallet)]);
    walletCreditsTotal += walletCredits;
    stableTotal += stableBalance;
    const t = telemetry?.[p.id];
    participants.push({
      id: p.id,
      role: p.role,
      label: p.label,
      wallet: p.wallet,
      pvGeneratedKwh: t ? t.pvWh / 1000 : null,
      loadKwh: t ? t.loadWh / 1000 : null,
      exportedKwh: kwh(a.exported),
      importedKwh: kwh(a.imported),
      creditsBurnedKwh: kwh(a.burned),
      gridSuppliedKwh: kwh(a.imported - a.burned),
      listedKwh: kwh(a.listed),
      soldKwh: kwh(a.sold),
      revenueUsd: usd(a.revenue),
      avgSaleUsdPerKwh: a.sold > 0n ? usd(a.revenue) / kwh(a.sold) : null,
      boughtKwh: kwh(a.bought),
      spentUsd: usd(a.spent),
      avgBuyUsdPerKwh: a.bought > 0n ? usd(a.spent) / kwh(a.bought) : null,
      creditsInWalletKwh: kwh(walletCredits),
      creditsInOpenListingsKwh: kwh(a.escrow),
      stablecoinUsd: usd(stableBalance),
      upliftVsFeedInUsd: usd(a.revenue) - kwh(a.sold) * TARIFFS.feedInUsdPerKwh,
      savingsVsGridUsd: kwh(a.bought) * TARIFFS.gridRetailUsdPerKwh - usd(a.spent),
    });
  }

  const [totalSupply, marketEscrow, stableSupply] = await Promise.all([
    token.totalSupply(),
    token.balanceOf(deployment.contracts.marketplace),
    stable.totalSupply(),
  ]);
  const checks: IntegrityCheck[] = [
    {
      name: "Every credit traces to a signed meter reading",
      ok: mintedTotal === exportedTotal,
      detail: `minted ${kwh(mintedTotal)} kWh = verified exports ${kwh(exportedTotal)} kWh`,
    },
    {
      name: "No interval credited twice",
      ok: duplicateIntervals === 0,
      detail: `${seenIntervals.size} unique (meter, interval) pairs, ${duplicateIntervals} duplicates`,
    },
    {
      name: "Supply = minted - burned",
      ok: totalSupply === mintedTotal - burnedTotal,
      detail: `totalSupply ${kwh(totalSupply)} kWh = ${kwh(mintedTotal)} - ${kwh(burnedTotal)}`,
    },
    {
      name: "Supply = wallets + marketplace escrow",
      ok: totalSupply === walletCreditsTotal + marketEscrow,
      detail: `${kwh(walletCreditsTotal)} kWh in wallets + ${kwh(marketEscrow)} kWh in escrow`,
    },
    {
      name: "Escrow = open listings",
      ok: marketEscrow === escrowTotal,
      detail: `marketplace holds ${kwh(marketEscrow)} kWh; open listings total ${kwh(escrowTotal)} kWh`,
    },
    {
      name: "Stablecoin conserved (payments only move between participants)",
      ok: stableTotal === stableSupply,
      detail: `participants hold $${usd(stableTotal).toFixed(2)} of $${usd(stableSupply).toFixed(2)} issued`,
    },
  ];

  const times = readings.map((r) => Number(r.args.intervalStart));
  return {
    simDate: deployment.simDate,
    period: { from: times.length ? Math.min(...times) : null, to: times.length ? Math.max(...times) + 900 : null },
    counts: { readings: readings.length, listings: created.length, trades: trades.length, cancellations: cancelled.length },
    participants,
    totals: {
      exportedKwh: kwh(exportedTotal),
      importedKwh: participants.reduce((s, p) => s + p.importedKwh, 0),
      mintedKwh: kwh(mintedTotal),
      burnedKwh: kwh(burnedTotal),
      tradedKwh: kwh(tradedWh),
      tradedUsd: usd(tradedUnits),
      avgTradeUsdPerKwh: tradedWh > 0n ? usd(tradedUnits) / kwh(tradedWh) : null,
      creditsOutstandingKwh: kwh(totalSupply),
    },
    checks,
    tariffs: TARIFFS,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const f2 = (n: number | null) => (n === null ? "—" : n.toFixed(2));
const money = (n: number) => (n < 0 ? `-$${(-n).toFixed(2)}` : `$${n.toFixed(2)}`);
const signedMoney = (n: number) => (n < 0 ? money(n) : `+${money(n)}`);
const price = (n: number | null) => (n === null ? "—" : `$${n.toFixed(3)}`);

function table(headers: string[], rows: string[][], rightAlignFrom = 1): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const pad = (cell: string, i: number) => (i >= rightAlignFrom ? cell.padStart(widths[i]) : cell.padEnd(widths[i]));
  const line = (cells: string[]) => `| ${cells.map(pad).join(" | ")} |`;
  const rule = `|${widths.map((w, i) => (i >= rightAlignFrom ? `${"-".repeat(w + 1)}:` : `${"-".repeat(w + 2)}`)).join("|")}|`;
  return [line(headers), rule, ...rows.map(line)].join("\n");
}

export function renderMarkdown(r: SettlementReport): string {
  const prosumers = r.participants.filter((p) => p.role === "prosumer");
  const consumers = r.participants.filter((p) => p.role === "consumer");
  const period = r.period.from === null ? "no readings" : `${hhmm(r.period.from)}–${r.period.to! - r.period.from >= 86400 ? "24:00" : hhmm(r.period.to!)} UTC`;
  const t = r.totals;

  return [
    `# Settlement report — ${r.simDate}`,
    "",
    `Period ${period} · ${r.counts.readings} verified readings · ${r.counts.listings} listings · ${r.counts.trades} trades · ${r.counts.cancellations} cancellations`,
    "",
    `Tariff assumptions: grid retail $${r.tariffs.gridRetailUsdPerKwh.toFixed(2)}/kWh, utility feed-in $${r.tariffs.feedInUsdPerKwh.toFixed(2)}/kWh.`,
    "Energy figures in kWh. \"PV generated\" and \"Load\" are simulator telemetry (behind the meter); everything else is read from the chain.",
    "",
    "## Prosumers",
    "",
    table(
      ["Prosumer", "PV generated", "Exported (minted)", "Sold P2P", "Earnings", "Avg price", "vs feed-in", "Self-used credits", "Unsold (listed / wallet)"],
      prosumers.map((p) => [
        p.label,
        f2(p.pvGeneratedKwh),
        f2(p.exportedKwh),
        f2(p.soldKwh),
        money(p.revenueUsd),
        price(p.avgSaleUsdPerKwh),
        signedMoney(p.upliftVsFeedInUsd),
        f2(p.creditsBurnedKwh),
        `${f2(p.creditsInOpenListingsKwh)} / ${f2(p.creditsInWalletKwh)}`,
      ]),
    ),
    "",
    "## Consumers",
    "",
    table(
      ["Consumer", "Load", "Bought P2P", "Spent", "Avg price", "Consumed from credits", "Grid-supplied", "Credits left", "Saved vs grid"],
      consumers.map((p) => [
        p.label,
        f2(p.loadKwh),
        f2(p.boughtKwh),
        money(p.spentUsd),
        price(p.avgBuyUsdPerKwh),
        f2(p.creditsBurnedKwh),
        f2(p.gridSuppliedKwh),
        f2(p.creditsInWalletKwh),
        signedMoney(p.savingsVsGridUsd),
      ]),
    ),
    "",
    "## Totals",
    "",
    table(
      ["Metric", "Value"],
      [
        ["Verified export = credits minted", `${f2(t.mintedKwh)} kWh`],
        ["Verified grid import (all meters)", `${f2(t.importedKwh)} kWh`],
        ["Credits burned on consumption", `${f2(t.burnedKwh)} kWh`],
        ["Traded peer-to-peer", `${f2(t.tradedKwh)} kWh for ${money(t.tradedUsd)} (avg ${price(t.avgTradeUsdPerKwh)}/kWh)`],
        ["Credits outstanding (supply)", `${f2(t.creditsOutstandingKwh)} kWh`],
      ],
    ),
    "",
    "## Integrity checks",
    "",
    ...r.checks.map((c) => `- ${c.ok ? "PASS" : "FAIL"} — ${c.name}: ${c.detail}`),
    "",
  ].join("\n");
}

/** Write the report as Markdown and JSON under reports/. Returns the Markdown path. */
export function saveReport(r: SettlementReport, dir = REPORTS_DIR): string {
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `settlement-${r.simDate}`);
  fs.writeFileSync(`${base}.md`, renderMarkdown(r));
  fs.writeFileSync(`${base}.json`, JSON.stringify(r, null, 2));
  return `${base}.md`;
}

export function telemetryPath(simDate: string, dir = REPORTS_DIR): string {
  return path.join(dir, `telemetry-${simDate}.json`);
}

export function loadTelemetry(simDate: string): Telemetry | undefined {
  const file = telemetryPath(simDate);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Telemetry) : undefined;
}
