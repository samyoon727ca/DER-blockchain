import { getAddress, isAddress, isHexString, type TypedDataDomain } from "ethers";
import { INTERVAL_SECONDS, readingDigest, recoverReadingSigner, type SignedReading } from "../shared/reading";

/**
 * Pure validation rules applied by the oracle before anything touches the
 * chain. EnergyToken re-checks the security-critical subset on-chain.
 */

export type RejectCode =
  | "MALFORMED"
  | "BAD_SIGNATURE"
  | "UNKNOWN_METER"
  | "METER_INACTIVE"
  | "MISALIGNED_INTERVAL"
  | "FUTURE_INTERVAL"
  | "STALE_READING"
  | "DUPLICATE"
  | "INTERVAL_ALREADY_SETTLED"
  | "REPLAYED_NONCE"
  | "EXPORT_ABOVE_CAPACITY"
  | "IMPORT_ABOVE_CAPACITY";

export interface MeterInfo {
  owner: string;
  maxExportWh: number;
  maxImportWh: number;
  active: boolean;
}

/** Highest nonce / interval the oracle has already accepted for a meter. */
export interface MeterCursor {
  lastNonce: number;
  lastIntervalStart: number;
}

export interface ValidationContext {
  domain: TypedDataDomain;
  nowSeconds: number; // chain time
  maxReadingAgeSeconds: number;
  meter: MeterInfo | undefined; // registry entry for reading.meter, undefined if unregistered
  cursor: MeterCursor;
  seenDigests: { has(digest: string): boolean }; // digests of accepted readings still inside the age window
}

export type Verdict = { ok: true; digest: string } | { ok: false; code: RejectCode; detail: string };

const UINT32_MAX = 2 ** 32 - 1;

function isUint(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

/** Shape-check an untrusted request body. Returns a normalised reading or a MALFORMED verdict. */
export function parseSignedReading(body: unknown): SignedReading | Extract<Verdict, { ok: false }> {
  const malformed = (detail: string) => ({ ok: false as const, code: "MALFORMED" as const, detail });
  if (typeof body !== "object" || body === null) return malformed("body must be a JSON object");
  const { reading, signature } = body as { reading?: Record<string, unknown>; signature?: unknown };
  if (typeof reading !== "object" || reading === null) return malformed("missing reading");
  if (typeof signature !== "string" || !isHexString(signature)) return malformed("signature must be a hex string");
  if (typeof reading.meter !== "string" || !isAddress(reading.meter)) return malformed("meter must be an address");
  if (!isUint(reading.intervalStart)) return malformed("intervalStart must be a non-negative integer");
  if (!isUint(reading.exportedWh, UINT32_MAX)) return malformed("exportedWh must be a uint32");
  if (!isUint(reading.importedWh, UINT32_MAX)) return malformed("importedWh must be a uint32");
  if (!isUint(reading.nonce)) return malformed("nonce must be a non-negative integer");
  return {
    reading: {
      meter: getAddress(reading.meter),
      intervalStart: reading.intervalStart,
      exportedWh: reading.exportedWh,
      importedWh: reading.importedWh,
      nonce: reading.nonce,
    },
    signature,
  };
}

export function validateReading({ reading, signature }: SignedReading, ctx: ValidationContext): Verdict {
  const reject = (code: RejectCode, detail: string): Verdict => ({ ok: false, code, detail });

  // 1. Authenticity: signed by the meter it claims to come from, in the one
  //    encoding the contract accepts (65 bytes, v = 27/28, low s).
  const signer = recoverReadingSigner(ctx.domain, reading, signature);
  if (signer === null || signer !== reading.meter) {
    return reject("BAD_SIGNATURE", `signature is not a valid signature by meter ${reading.meter}`);
  }

  // 2. The meter must be registered and in service.
  if (!ctx.meter) return reject("UNKNOWN_METER", `meter ${reading.meter} is not registered`);
  if (!ctx.meter.active) return reject("METER_INACTIVE", `meter ${reading.meter} is suspended`);

  // 3. Timestamps: aligned, finished, and not too old.
  if (reading.intervalStart % INTERVAL_SECONDS !== 0) {
    return reject("MISALIGNED_INTERVAL", `intervalStart ${reading.intervalStart} is not on a 15-minute boundary`);
  }
  const intervalEnd = reading.intervalStart + INTERVAL_SECONDS;
  if (intervalEnd > ctx.nowSeconds) {
    return reject("FUTURE_INTERVAL", `interval ends at ${intervalEnd}, chain time is ${ctx.nowSeconds}`);
  }
  if (ctx.nowSeconds - intervalEnd > ctx.maxReadingAgeSeconds) {
    return reject("STALE_READING", `reading is older than ${ctx.maxReadingAgeSeconds}s`);
  }

  // 4. Replay and double counting.
  const digest = readingDigest(ctx.domain, reading);
  if (ctx.seenDigests.has(digest)) return reject("DUPLICATE", "identical reading was already accepted (replay)");
  if (reading.intervalStart <= ctx.cursor.lastIntervalStart) {
    return reject("INTERVAL_ALREADY_SETTLED", "this meter already reported this or a later interval (double counting)");
  }
  if (reading.nonce <= ctx.cursor.lastNonce) {
    return reject("REPLAYED_NONCE", `nonce ${reading.nonce} <= last accepted ${ctx.cursor.lastNonce}`);
  }

  // 5. Physical plausibility.
  if (reading.exportedWh > ctx.meter.maxExportWh) {
    return reject(
      "EXPORT_ABOVE_CAPACITY",
      `exported ${reading.exportedWh} Wh > rated ${ctx.meter.maxExportWh} Wh per interval`,
    );
  }
  if (reading.importedWh > ctx.meter.maxImportWh) {
    return reject(
      "IMPORT_ABOVE_CAPACITY",
      `imported ${reading.importedWh} Wh > service limit ${ctx.meter.maxImportWh} Wh per interval`,
    );
  }

  return { ok: true, digest };
}
