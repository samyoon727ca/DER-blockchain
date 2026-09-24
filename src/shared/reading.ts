import { TypedDataEncoder, verifyTypedData, type Signer, type TypedDataDomain } from "ethers";

/** One 15-minute interval as measured and signed by a smart meter. Mirrors EnergyToken.MeterReading. */
export interface MeterReading {
  meter: string; // meter signing address (also its id)
  intervalStart: number; // unix seconds, multiple of INTERVAL_SECONDS
  exportedWh: number; // delivered to the grid
  importedWh: number; // drawn from the grid
  nonce: number; // strictly increasing per meter
}

export interface SignedReading {
  reading: MeterReading;
  signature: string;
}

export const INTERVAL_SECONDS = 15 * 60;
export const INTERVALS_PER_DAY = (24 * 60 * 60) / INTERVAL_SECONDS;

export const READING_TYPES = {
  MeterReading: [
    { name: "meter", type: "address" },
    { name: "intervalStart", type: "uint64" },
    { name: "exportedWh", type: "uint32" },
    { name: "importedWh", type: "uint32" },
    { name: "nonce", type: "uint64" },
  ],
};

/** EIP-712 domain of the EnergyToken contract: binds signatures to one chain and one contract. */
export function readingDomain(chainId: bigint | number, energyToken: string): TypedDataDomain {
  return { name: "EnergyToken", version: "1", chainId, verifyingContract: energyToken };
}

export function signReading(signer: Signer, domain: TypedDataDomain, reading: MeterReading): Promise<string> {
  return signer.signTypedData(domain, READING_TYPES, reading);
}

/** Address that produced `signature` over `reading`, or null if the signature is malformed. */
export function recoverReadingSigner(domain: TypedDataDomain, reading: MeterReading, signature: string): string | null {
  try {
    return verifyTypedData(domain, READING_TYPES, reading, signature);
  } catch {
    return null;
  }
}

/** Unique id of a signed reading's contents (used to detect exact replays). */
export function readingDigest(domain: TypedDataDomain, reading: MeterReading): string {
  return TypedDataEncoder.hash(domain, READING_TYPES, reading);
}
