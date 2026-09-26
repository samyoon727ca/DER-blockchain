import fs from "node:fs";
import path from "node:path";
import { JsonRpcProvider, type ContractRunner, type Interface } from "ethers";
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
  /** Mock stablecoin minted to this wallet at deployment, in whole USD (the only mUSD ever issued). */
  startingUsd: number;
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
  // Tuned for an automining local chain:
  //  - staticNetwork skips a chainId round-trip on every call;
  //  - cacheTimeout -1 disables ethers' 250 ms response cache, which would
  //    otherwise hand out stale nonces when a wallet sends transactions back to back;
  //  - batchMaxCount 1 sends each request immediately instead of waiting to batch.
  return new JsonRpcProvider(rpcUrl, HARDHAT_CHAIN_ID, {
    staticNetwork: true,
    pollingInterval: 100,
    cacheTimeout: -1,
    batchMaxCount: 1,
  });
}

export function connectContracts(d: Deployment, runner: ContractRunner): Contracts {
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

interface EthersError {
  code?: string;
  data?: unknown;
  revert?: { name?: string };
  shortMessage?: string;
  message?: string;
}

/**
 * Custom-error name of a contract revert, e.g. "StaleNonce". Works for errors
 * from a JSON-RPC provider (decoded by ethers) and from Hardhat's in-process
 * provider (raw revert data, decoded here with `iface`).
 */
export function revertName(err: unknown, iface?: Interface): string {
  const e = err as EthersError;
  if (e.revert?.name) return e.revert.name;
  if (iface && typeof e.data === "string") {
    try {
      const parsed = iface.parseError(e.data);
      if (parsed) return parsed.name;
    } catch {
      // not one of this contract's errors
    }
  }
  return e.shortMessage ?? e.message ?? String(err);
}

/** True if the error is a contract revert (as opposed to e.g. a network failure). */
export function isRevert(err: unknown): boolean {
  const e = err as EthersError;
  return e.code === "CALL_EXCEPTION" || (typeof e.data === "string" && e.data.startsWith("0x"));
}
