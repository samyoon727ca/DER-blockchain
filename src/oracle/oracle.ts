import type { Provider, TransactionReceipt, TypedDataDomain } from "ethers";
import type { EnergyToken } from "../../typechain-types";
import { isRevert, revertName } from "../shared/chain";
import { INTERVAL_SECONDS, type SignedReading } from "../shared/reading";
import {
  parseSignedReading,
  validateReading,
  type MeterCursor,
  type MeterInfo,
  type RejectCode,
} from "./validation";

export type ReadingStatus = "settled" | "queued" | "rejected";

export interface OracleResult {
  status: ReadingStatus;
  code?: RejectCode | "ONCHAIN_REVERT";
  detail?: string;
  txHash?: string;
  mintedWh?: number;
  burnedWh?: number;
}

export interface OracleLogEntry extends OracleResult {
  receivedAt: number; // chain time when the oracle saw it
  meter?: string;
  intervalStart?: number;
  exportedWh?: number;
  importedWh?: number;
  nonce?: number;
}

interface QueuedReading {
  signed: SignedReading;
  digest: string;
  log: OracleLogEntry;
  /** Last transaction sent for this reading, so a send whose confirmation was lost can be reconciled. */
  txHash?: string;
}

export interface OracleOptions {
  /** Readings whose interval ended longer ago than this are refused. */
  maxReadingAgeSeconds?: number;
  logSize?: number;
}

/**
 * The oracle service: validates signed meter readings and relays accepted ones
 * to EnergyToken.submitReading, in order, one transaction at a time.
 *
 * Accepted readings go through a FIFO queue. If the token is paused, the queue
 * holds them and retries later, so an emergency stop loses no data and
 * per-meter ordering (which the contract enforces) is preserved.
 */
export class Oracle {
  readonly stats = { received: 0, settled: 0, queued: 0, rejected: 0 };
  readonly log: OracleLogEntry[] = [];
  /** Rejections are rare and interesting, so they are kept separately from the rolling log. */
  readonly rejections: OracleLogEntry[] = [];
  private readonly cursors = new Map<string, MeterCursor>();
  /** Digest -> interval end of each accepted reading, kept only while a replay of it would not be stale. */
  private readonly seenDigests = new Map<string, number>();
  private readonly queue: QueuedReading[] = [];
  private draining: Promise<void> = Promise.resolve();
  private retryTimer?: NodeJS.Timeout;
  private readonly maxReadingAgeSeconds: number;
  private readonly logSize: number;

  constructor(
    private readonly token: EnergyToken, // connected to the oracle's signer
    private readonly provider: Provider,
    private readonly domain: TypedDataDomain,
    opts: OracleOptions = {},
  ) {
    this.maxReadingAgeSeconds = opts.maxReadingAgeSeconds ?? 6 * 3600;
    this.logSize = opts.logSize ?? 500;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  /** Retry queued readings periodically (e.g. after an unpause). */
  start(intervalMs = 2000): void {
    this.retryTimer = setInterval(() => {
      if (this.queue.length > 0) void this.drain();
    }, intervalMs);
    this.retryTimer.unref();
  }

  stop(): void {
    if (this.retryTimer) clearInterval(this.retryTimer);
  }

  /** Handle one untrusted submission from a meter. */
  async handle(body: unknown): Promise<OracleResult> {
    this.stats.received++;
    const nowSeconds = (await this.provider.getBlock("latest"))!.timestamp;

    const parsed = parseSignedReading(body);
    if ("ok" in parsed) return this.record({ receivedAt: nowSeconds, status: "rejected", code: parsed.code, detail: parsed.detail });

    const { reading } = parsed;
    const entry: OracleLogEntry = {
      receivedAt: nowSeconds,
      meter: reading.meter,
      intervalStart: reading.intervalStart,
      exportedWh: reading.exportedWh,
      importedWh: reading.importedWh,
      nonce: reading.nonce,
      status: "queued",
    };

    const meter = await this.lookupMeter(reading.meter);
    // No awaits from here until the reading is recorded as accepted, so two concurrent
    // copies of the same reading cannot both pass validation.
    this.pruneDigests(nowSeconds);
    const verdict = validateReading(parsed, {
      domain: this.domain,
      nowSeconds,
      maxReadingAgeSeconds: this.maxReadingAgeSeconds,
      meter: meter?.info,
      cursor: this.cursor(reading.meter, meter?.chainCursor),
      seenDigests: this.seenDigests,
    });
    if (!verdict.ok) return this.record({ ...entry, status: "rejected", code: verdict.code, detail: verdict.detail });

    // Accepted: advance the cursor now so later readings are checked against it.
    this.seenDigests.set(verdict.digest, reading.intervalStart + INTERVAL_SECONDS);
    this.cursors.set(reading.meter, { lastNonce: reading.nonce, lastIntervalStart: reading.intervalStart });
    const item: QueuedReading = { signed: parsed, digest: verdict.digest, log: entry };
    this.queue.push(item);
    this.record(entry);

    await this.drain();
    return this.publicResult(item.log);
  }

  /** Submit queued readings in order. Serialised: only one drain runs at a time. */
  drain(): Promise<void> {
    this.draining = this.draining
      .then(() => this.drainOnce())
      .catch((err) => console.error("[oracle] drain failed:", err));
    return this.draining;
  }

  private async drainOnce(): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue[0];
      try {
        // An earlier attempt may have been mined even though its confirmation was lost;
        // resubmitting it would revert and wrongly report a credited reading as rejected.
        const earlier = item.txHash ? await this.provider.getTransactionReceipt(item.txHash) : null;
        const receipt = earlier?.status === 1 ? earlier : await this.submit(item);
        let mintedWh = 0;
        let burnedWh = 0;
        for (const log of receipt.logs) {
          const parsed = this.token.interface.parseLog(log);
          if (parsed?.name === "CreditsMinted") mintedWh = Number(parsed.args.amountWh);
          if (parsed?.name === "CreditsBurned") burnedWh = Number(parsed.args.amountWh);
        }
        this.queue.shift();
        this.transition(item.log, { status: "settled", txHash: receipt.hash, mintedWh, burnedWh });
      } catch (err) {
        const reason = revertName(err, this.token.interface);
        if (reason === "EnforcedPause") return; // token paused: keep the queue, retry later
        if (!isRevert(err)) return; // transient RPC failure: retry later
        // The contract disagreed with the oracle (e.g. state changed since validation). Drop it.
        this.queue.shift();
        this.forget(item);
        this.transition(item.log, { status: "rejected", code: "ONCHAIN_REVERT", detail: reason });
      }
    }
  }

  private async submit(item: QueuedReading): Promise<TransactionReceipt> {
    const tx = await this.token.submitReading(item.signed.reading, item.signed.signature);
    item.txHash = tx.hash;
    return (await tx.wait())!;
  }

  /**
   * Undo the acceptance of a reading the chain refused, so a correct copy of it
   * (or a re-signed one) can still settle. The meter's cursor falls back to its
   * latest reading still queued, or else to the chain's.
   */
  private forget(item: QueuedReading): void {
    this.seenDigests.delete(item.digest);
    const meter = item.signed.reading.meter;
    const pending = this.queue.filter((q) => q.signed.reading.meter === meter).at(-1)?.signed.reading;
    if (pending) this.cursors.set(meter, { lastNonce: pending.nonce, lastIntervalStart: pending.intervalStart });
    else this.cursors.delete(meter);
  }

  /** Drop digests of readings a replay of which would be rejected as stale anyway. */
  private pruneDigests(nowSeconds: number): void {
    for (const [digest, intervalEnd] of this.seenDigests) {
      if (nowSeconds - intervalEnd > this.maxReadingAgeSeconds) this.seenDigests.delete(digest);
    }
  }

  status() {
    return {
      stats: { ...this.stats },
      recent: this.log.slice(-200),
      rejections: this.rejections,
    };
  }

  private async lookupMeter(address: string): Promise<{ info: MeterInfo; chainCursor: MeterCursor } | undefined> {
    const m = await this.token.getMeter(address);
    if (m.owner === "0x0000000000000000000000000000000000000000") return undefined;
    return {
      info: { owner: m.owner, maxExportWh: Number(m.maxExportWh), maxImportWh: Number(m.maxImportWh), active: m.active },
      chainCursor: { lastNonce: Number(m.lastNonce), lastIntervalStart: Number(m.lastIntervalStart) },
    };
  }

  /** The stricter of what this oracle accepted and what the chain has settled (survives restarts). */
  private cursor(meter: string, chain?: MeterCursor): MeterCursor {
    const local = this.cursors.get(meter) ?? { lastNonce: 0, lastIntervalStart: 0 };
    return {
      lastNonce: Math.max(local.lastNonce, chain?.lastNonce ?? 0),
      lastIntervalStart: Math.max(local.lastIntervalStart, chain?.lastIntervalStart ?? 0),
    };
  }

  private record(entry: OracleLogEntry): OracleResult {
    this.log.push(entry);
    if (this.log.length > this.logSize) this.log.splice(0, this.log.length - this.logSize);
    this.stats[entry.status]++;
    if (entry.status === "rejected") this.keepRejection(entry);
    return this.publicResult(entry);
  }

  private keepRejection(entry: OracleLogEntry): void {
    this.rejections.push(entry);
    if (this.rejections.length > 100) this.rejections.shift();
  }

  private transition(entry: OracleLogEntry, update: OracleResult): void {
    this.stats[entry.status]--;
    Object.assign(entry, update);
    this.stats[entry.status]++;
    if (entry.status === "rejected") this.keepRejection(entry);
  }

  private publicResult(e: OracleLogEntry): OracleResult {
    const { status, code, detail, txHash, mintedWh, burnedWh } = e;
    return { status, code, detail, txHash, mintedWh, burnedWh };
  }
}
