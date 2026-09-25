import type { TypedDataDomain } from "ethers";
import { SITE, meterKey, type ParticipantSpec } from "../shared/participants";
import { INTERVALS_PER_DAY, INTERVAL_SECONDS, type SignedReading } from "../shared/reading";
import { Household, dayOfYear, neighbourhoodClearness, type IntervalFlows } from "./physics";
import { SmartMeter } from "./meter";
import { createRng, seedFrom } from "./rng";

export interface MeterOutput {
  participant: ParticipantSpec;
  flows: IntervalFlows;
  signed: SignedReading;
}

export interface TelemetryTotals {
  pvWh: number;
  loadWh: number;
  exportedWh: number;
  importedWh: number;
}

/**
 * Generates a day of 15-minute data for every household and has each
 * household's meter sign it. Deterministic for a given seed.
 */
export class NeighbourhoodSimulator {
  readonly meters = new Map<string, SmartMeter>();
  readonly telemetry = new Map<string, TelemetryTotals>();
  private readonly households = new Map<string, Household>();
  private readonly clearness: number[];

  constructor(
    readonly participants: ParticipantSpec[],
    domain: TypedDataDomain,
    readonly dayStart: number, // unix seconds, 00:00 of the simulated day
    seed = 2026,
  ) {
    const doy = dayOfYear(new Date(dayStart * 1000));
    this.clearness = neighbourhoodClearness(createRng(seed), INTERVALS_PER_DAY);
    for (const p of participants) {
      this.households.set(p.id, new Household(p, createRng(seed ^ seedFrom(p.id)), SITE.latitudeDeg, doy));
      this.meters.set(p.id, new SmartMeter(p.id, meterKey(p.id), domain));
      this.telemetry.set(p.id, { pvWh: 0, loadWh: 0, exportedWh: 0, importedWh: 0 });
    }
  }

  intervalStart(index: number): number {
    return this.dayStart + index * INTERVAL_SECONDS;
  }

  /** Simulate interval `index` (0..95) for every home and return the signed meter readings. */
  async readInterval(index: number): Promise<MeterOutput[]> {
    const intervalStart = this.intervalStart(index);
    const hour = (index * INTERVAL_SECONDS) / 3600;
    const out: MeterOutput[] = [];
    for (const participant of this.participants) {
      const flows = this.households.get(participant.id)!.step(hour, this.clearness[index]);
      const t = this.telemetry.get(participant.id)!;
      t.pvWh += flows.pvWh;
      t.loadWh += flows.loadWh;
      t.exportedWh += flows.exportedWh;
      t.importedWh += flows.importedWh;
      const signed = await this.meters.get(participant.id)!.sign({
        intervalStart,
        exportedWh: flows.exportedWh,
        importedWh: flows.importedWh,
      });
      out.push({ participant, flows, signed });
    }
    return out;
  }
}
