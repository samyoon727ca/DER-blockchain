import fs from "node:fs";
import path from "node:path";
import { JsonRpcProvider, type Signer } from "ethers";
import {
  EnergyMarketplace__factory,
  EnergyToken__factory,
  MockStablecoin__factory,
  type EnergyMarketplace,
  type EnergyToken,
  type MockStablecoin,
} from "../../typechain-types";
import type { Role } from "./participants";

export const ROOT_DIR = path.resolve(__dirname, "..", "..");
export const DEPLOYMENT_FILE = path.join(ROOT_DIR, "deployments", "localhost.json");
export const REPORTS_DIR = path.join(ROOT_DIR, "reports");
export const HARDHAT_CHAIN_ID = 31337;

export interface ParticipantRecord {
  id: string;
  role: Role;
  label: string;
  wallet: string;
  meter: string;
  pvKw: number;
  batteryKwh: number;
  maxExportWh: number;
  maxImportWh: number;
}

/** Written by the demo after deployment; read by the report script and the dashboard. */
export interface Deployment {
  chainId: number;
  rpcUrl: string;
  simDate: string; // YYYY-MM-DD of the simulated day (UTC clock)
  contracts: { energyToken: string; marketplace: string; stablecoin: string };
  admin: string;
  oracle: string;
  participants: ParticipantRecord[];
}

export interface Contracts {
  token: EnergyToken;
  market: EnergyMarketplace;
  stable: MockStablecoin;
}

export function rpcProvider(rpcUrl: string): JsonRpcProvider {
  // staticNetwork skips a chainId round-trip on every call; the fast polling
  // interval suits an automining local chain.
  return new JsonRpcProvider(rpcUrl, HARDHAT_CHAIN_ID, { staticNetwork: true, pollingInterval: 100 });
}

export function connectContracts(d: Deployment, runner: Signer | JsonRpcProvider): Contracts {
  return {
    token: EnergyToken__factory.connect(d.contracts.energyToken, runner),
    market: EnergyMarketplace__factory.connect(d.contracts.marketplace, runner),
    stable: MockStablecoin__factory.connect(d.contracts.stablecoin, runner),
  };
}

export function saveDeployment(d: Deployment): void {
  fs.mkdirSync(path.dirname(DEPLOYMENT_FILE), { recursive: true });
  fs.writeFileSync(DEPLOYMENT_FILE, JSON.stringify(d, null, 2));
}

export function loadDeployment(): Deployment {
  if (!fs.existsSync(DEPLOYMENT_FILE)) {
    throw new Error(`No deployment found at ${DEPLOYMENT_FILE}. Run "npm run demo" first.`);
  }
  return JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf8")) as Deployment;
}

/** Decoded custom-error name from an ethers contract error, e.g. "StaleNonce". */
export function revertName(err: unknown): string {
  const e = err as { revert?: { name?: string }; shortMessage?: string; message?: string };
  return e.revert?.name ?? e.shortMessage ?? e.message ?? String(err);
}
