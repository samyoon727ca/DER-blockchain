import type { ParticipantSpec } from "../shared/participants";
import { normal, type Rng } from "./rng";

/**
 * Deliberately simple physical models: good enough to produce realistic-looking
 * 15-minute interval data, not for engineering use.
 */

const DEG = Math.PI / 180;

export function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  return Math.floor((date.getTime() - start) / 86_400_000);
}

/** Sine of the sun's elevation for a latitude, day of year and local solar hour. */
export function solarElevationSin(latitudeDeg: number, doy: number, hour: number): number {
  const declination = 23.44 * DEG * Math.sin((2 * Math.PI * (284 + doy)) / 365);
  const hourAngle = (hour - 12) * 15 * DEG;
  const lat = latitudeDeg * DEG;
  return Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle);
}

/**
 * Fraction of PV nameplate delivered under a clear sky, including ~15% system
 * losses. The exponent approximates extra atmospheric losses at low sun angles.
 */
export function clearSkyPvFraction(sinElevation: number): number {
  return sinElevation <= 0 ? 0 : 0.85 * Math.pow(sinElevation, 1.25);
}

/** Average clear-sky PV fraction over a 15-minute interval starting at `hour`. */
export function intervalPvFraction(latitudeDeg: number, doy: number, hour: number): number {
  const samples = [2.5, 7.5, 12.5].map((min) => clearSkyPvFraction(solarElevationSin(latitudeDeg, doy, hour + min / 60)));
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

/**
 * Neighbourhood-wide sky clearness per interval (1 = clear). Clouds pass over
 * all homes at once, so sites are correlated; each site adds its own noise.
 */
export function neighbourhoodClearness(rng: Rng, intervals: number): number[] {
  const out: number[] = [];
  let cloudDepth = 0;
  let cloudLeft = 0;
  for (let i = 0; i < intervals; i++) {
    if (cloudLeft <= 0 && rng() < 0.07) {
      cloudDepth = 0.25 + rng() * 0.5; // a passing cloud blocks 25-75% of the sun
      cloudLeft = 1 + Math.floor(rng() * 4); // for 15-60 minutes
    }
    const attenuation = cloudLeft > 0 ? cloudDepth : 0;
    cloudLeft--;
    out.push(clamp(0.97 - attenuation + 0.02 * normal(rng), 0.1, 1));
  }
  return out;
}

function bump(hour: number, centre: number, width: number): number {
  return Math.exp(-0.5 * ((hour - centre) / width) ** 2);
}

/** Random appliance use (kettle, oven, dryer...): in waking hours, sometimes 1.5-2.5 kW extra for an interval. */
const SPIKE = { fromHour: 6, toHour: 23, probability: 0.05, minKw: 1.5, rangeKw: 1 };
const inSpikeHours = (hour: number) => hour >= SPIKE.fromHour && hour < SPIKE.toHour;

/** Household demand in kW at a given hour, without random appliance spikes. */
function scheduledLoadKw(spec: ParticipantSpec, hour: number): number {
  const l = spec.load;
  let kw =
    l.baseKw +
    l.morningKw * bump(hour, 7.5, 1.0) +
    l.middayKw * bump(hour, 13, 2.2) +
    l.eveningKw * bump(hour, 19.5, 1.6);
  if (spec.ev && hour >= spec.ev.startHour && hour < spec.ev.endHour) kw += spec.ev.kw;
  return kw;
}

/** Expected (mean) household demand in kW at a given hour, including appliance spikes; agents use it to plan purchases. */
export function expectedLoadKw(spec: ParticipantSpec, hour: number): number {
  const meanSpikeKw = inSpikeHours(hour) ? SPIKE.probability * (SPIKE.minKw + SPIKE.rangeKw / 2) : 0;
  return scheduledLoadKw(spec, hour) + meanSpikeKw;
}

export interface IntervalFlows {
  pvWh: number; // generated behind the meter
  loadWh: number; // household consumption
  batteryWh: number; // + charging, - discharging
  batterySocKwh: number;
  exportedWh: number; // measured at the grid meter
  importedWh: number; // measured at the grid meter
}

/** One home: PV + load + optional battery (self-consumption strategy) behind a grid meter. */
export class Household {
  private socKwh: number;

  constructor(
    readonly spec: ParticipantSpec,
    private readonly rng: Rng,
    private readonly latitudeDeg: number,
    private readonly doy: number,
  ) {
    this.socKwh = spec.battery ? spec.battery.capacityKwh * 0.35 : 0;
  }

  step(hour: number, clearness: number): IntervalFlows {
    const { spec, rng } = this;
    const hours = 0.25;

    const siteClearness = clamp(clearness * (1 + 0.04 * normal(rng)), 0, 1);
    const pvKwh = spec.pvKw * intervalPvFraction(this.latitudeDeg, this.doy, hour) * siteClearness * hours;

    let loadKw = scheduledLoadKw(spec, hour + 0.125) * (1 + 0.15 * normal(rng));
    if (inSpikeHours(hour) && rng() < SPIKE.probability) loadKw += SPIKE.minKw + SPIKE.rangeKw * rng();
    const loadKwh = Math.max(0.05, loadKw) * hours;

    let net = pvKwh - loadKwh; // + surplus, - deficit
    let batteryKwh = 0;
    const b = spec.battery;
    if (b) {
      const oneWay = Math.sqrt(b.roundTripEfficiency);
      const maxStep = b.maxKw * hours;
      const minSoc = b.capacityKwh * 0.1;
      if (net > 0) {
        const charge = Math.min(net, maxStep, (b.capacityKwh - this.socKwh) / oneWay);
        this.socKwh += charge * oneWay;
        net -= charge;
        batteryKwh = charge;
      } else if (net < 0) {
        const discharge = Math.min(-net, maxStep, Math.max(0, (this.socKwh - minSoc) * oneWay));
        this.socKwh -= discharge / oneWay;
        net += discharge;
        batteryKwh = -discharge;
      }
    }

    return {
      pvWh: Math.round(pvKwh * 1000),
      loadWh: Math.round(loadKwh * 1000),
      batteryWh: Math.round(batteryKwh * 1000),
      batterySocKwh: Math.round(this.socKwh * 100) / 100,
      exportedWh: Math.round(Math.max(0, net) * 1000),
      importedWh: Math.round(Math.max(0, -net) * 1000),
    };
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
