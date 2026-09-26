import { TypedDataEncoder, isHexString, verifyTypedData, type Signer, type TypedDataDomain } from "ethers";

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

/** Half the secp256k1 group order: OpenZeppelin's ECDSA rejects any signature with a larger `s`. */
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * True if `signature` is in the only encoding EnergyToken accepts (OpenZeppelin ECDSA):
 * 65 bytes r || s || v with v = 27 or 28 and a low `s`. ethers also accepts 64-byte
 * compact signatures, v = 0/1 and high-s forms, which the contract would reject.
 */
export function isCanonicalSignature(signature: string): boolean {
  if (!isHexString(signature, 65)) return false;
  const v = parseInt(signature.slice(130, 132), 16);
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  return (v === 27 || v === 28) && s <= SECP256K1_HALF_N;
}

/**
 * Address that produced `signature` over `reading`, or null if the signature is
 * malformed or not in the canonical form EnergyToken accepts.
 */
export function recoverReadingSigner(domain: TypedDataDomain, reading: MeterReading, signature: string): string | null {
  if (!isCanonicalSignature(signature)) return null;
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
