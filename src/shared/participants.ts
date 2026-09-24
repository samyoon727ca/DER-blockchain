import { HDNodeWallet, Mnemonic, Wallet, id, type Provider } from "ethers";

/**
 * The simulated neighbourhood: 5 prosumers (rooftop PV, some with batteries)
 * and 5 consumers. All numbers are illustrative residential values.
 */

export type Role = "prosumer" | "consumer";

export interface LoadShape {
  baseKw: number; // always-on load (fridge, standby)
  morningKw: number; // extra load around 07:30
  middayKw: number; // extra load around 13:00
  eveningKw: number; // extra load around 19:30
}

export interface BatterySpec {
  capacityKwh: number;
  maxKw: number; // charge/discharge power limit
  roundTripEfficiency: number;
}

export interface ParticipantSpec {
  id: string;
  role: Role;
  label: string;
  /** Index into Hardhat's default test accounts for this household's wallet. */
  accountIndex: number;
  pvKw: number; // PV nameplate (0 for consumers)
  battery?: BatterySpec;
  load: LoadShape;
  ev?: { kw: number; startHour: number; endHour: number };
  serviceKw: number; // grid connection limit
  /** Prosumer: opening ask price, USD/kWh. */
  askUsdPerKwh?: number;
  /** Consumer: highest P2P price accepted, USD/kWh. */
  maxUsdPerKwh?: number;
}

export const SITE = {
  latitudeDeg: 37.4, // clock time is treated as local solar time (see README assumptions)
};

export const TARIFFS = {
  /** What a consumer pays the utility for grid energy. */
  gridRetailUsdPerKwh: 0.3,
  /** What the utility would pay a prosumer for exports without the marketplace. */
  feedInUsdPerKwh: 0.05,
  /** Prosumers never discount below this; they keep the credits instead. */
  prosumerFloorUsdPerKwh: 0.08,
};

/** Starting mock-stablecoin balance for every consumer, in USD. */
export const CONSUMER_STARTING_USD = 25;

export const ACCOUNT_INDEX = {
  admin: 0, // deployer: DEFAULT_ADMIN, REGISTRAR, PAUSER
  oracle: 1, // ORACLE_ROLE
  attacker: 12, // used by the security scenarios
};

const HOME_BATTERY: BatterySpec = { capacityKwh: 10, maxKw: 5, roundTripEfficiency: 0.9 };

export const PARTICIPANTS: ParticipantSpec[] = [
  {
    id: "P1", role: "prosumer", label: "P1 · 6 kW PV + 10 kWh battery", accountIndex: 2,
    pvKw: 6, battery: HOME_BATTERY, serviceKw: 24, askUsdPerKwh: 0.14,
    load: { baseKw: 0.35, morningKw: 0.9, middayKw: 0.3, eveningKw: 1.4 },
  },
  {
    id: "P2", role: "prosumer", label: "P2 · 4.5 kW PV", accountIndex: 3,
    pvKw: 4.5, serviceKw: 24, askUsdPerKwh: 0.12,
    load: { baseKw: 0.3, morningKw: 0.7, middayKw: 0.2, eveningKw: 1.1 },
  },
  {
    id: "P3", role: "prosumer", label: "P3 · 8 kW PV + 13.5 kWh battery", accountIndex: 4,
    pvKw: 8, battery: { capacityKwh: 13.5, maxKw: 5, roundTripEfficiency: 0.9 }, serviceKw: 24, askUsdPerKwh: 0.16,
    load: { baseKw: 0.45, morningKw: 1.1, middayKw: 0.5, eveningKw: 1.8 },
  },
  {
    id: "P4", role: "prosumer", label: "P4 · 5 kW PV", accountIndex: 5,
    pvKw: 5, serviceKw: 24, askUsdPerKwh: 0.13,
    load: { baseKw: 0.3, morningKw: 0.8, middayKw: 0.6, eveningKw: 1.2 },
  },
  {
    id: "P5", role: "prosumer", label: "P5 · 7 kW PV + 10 kWh battery", accountIndex: 6,
    pvKw: 7, battery: HOME_BATTERY, serviceKw: 24, askUsdPerKwh: 0.15,
    load: { baseKw: 0.4, morningKw: 1.0, middayKw: 0.3, eveningKw: 1.6 },
  },
  {
    id: "C1", role: "consumer", label: "C1 · family home", accountIndex: 7,
    pvKw: 0, serviceKw: 24, maxUsdPerKwh: 0.22,
    load: { baseKw: 0.45, morningKw: 1.2, middayKw: 0.4, eveningKw: 2.0 },
  },
  {
    id: "C2", role: "consumer", label: "C2 · apartment", accountIndex: 8,
    pvKw: 0, serviceKw: 12, maxUsdPerKwh: 0.2,
    load: { baseKw: 0.2, morningKw: 0.5, middayKw: 0.1, eveningKw: 0.9 },
  },
  {
    id: "C3", role: "consumer", label: "C3 · home + EV charging", accountIndex: 9,
    pvKw: 0, serviceKw: 24, maxUsdPerKwh: 0.24,
    load: { baseKw: 0.4, morningKw: 1.0, middayKw: 0.3, eveningKw: 1.5 },
    ev: { kw: 7.2, startHour: 18.5, endHour: 21 },
  },
  {
    id: "C4", role: "consumer", label: "C4 · home office", accountIndex: 10,
    pvKw: 0, serviceKw: 24, maxUsdPerKwh: 0.18,
    load: { baseKw: 0.35, morningKw: 0.8, middayKw: 1.2, eveningKw: 1.3 },
  },
  {
    id: "C5", role: "consumer", label: "C5 · small café", accountIndex: 11,
    pvKw: 0, serviceKw: 36, maxUsdPerKwh: 0.15,
    load: { baseKw: 0.6, morningKw: 2.5, middayKw: 2.0, eveningKw: 0.4 },
  },
];

/** Rated export per 15-minute interval: PV nameplate for a quarter hour. */
export function maxExportWh(p: ParticipantSpec): number {
  return Math.round(p.pvKw * 250);
}

/** Import limit per 15-minute interval: service connection for a quarter hour. */
export function maxImportWh(p: ParticipantSpec): number {
  return Math.round(p.serviceKw * 250);
}

/** Hardhat's well-known development mnemonic. Never use these keys anywhere real. */
const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

export function hardhatWallet(index: number, provider?: Provider): HDNodeWallet {
  const wallet = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(HARDHAT_MNEMONIC), `m/44'/60'/0'/0/${index}`);
  return provider ? wallet.connect(provider) : wallet;
}

/**
 * Each meter has its own signing key, separate from the owner's wallet (in
 * production it would live in the meter's secure element). Derived
 * deterministically so every demo run uses the same meter identities.
 */
export function meterKey(participantId: string): Wallet {
  return new Wallet(id(`der-poc/meter/${participantId}`));
}
