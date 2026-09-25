import type { TypedDataDomain, Wallet } from "ethers";
import { signReading, type MeterReading, type SignedReading } from "../shared/reading";

/**
 * A smart meter: holds its own signing key and a monotonic nonce, and signs
 * each 15-minute reading (EIP-712) before sending it to the oracle.
 */
export class SmartMeter {
  private nonce = 0;

  constructor(
    readonly participantId: string,
    private readonly key: Wallet,
    private readonly domain: TypedDataDomain,
  ) {}

  get address(): string {
    return this.key.address;
  }

  /** Sign a measurement. Each call consumes a nonce, like a real meter's counter. */
  async sign(measurement: { intervalStart: number; exportedWh: number; importedWh: number }): Promise<SignedReading> {
    const reading: MeterReading = { meter: this.address, ...measurement, nonce: ++this.nonce };
    return { reading, signature: await signReading(this.key, this.domain, reading) };
  }
}

export interface OracleResponse {
  status: "settled" | "queued" | "rejected";
  code?: string;
  detail?: string;
  txHash?: string;
  mintedWh?: number;
  burnedWh?: number;
}

/** Deliver a signed reading to the oracle over HTTP, as a meter's uplink would. */
export async function sendToOracle(oracleUrl: string, signed: SignedReading): Promise<OracleResponse> {
  const res = await fetch(`${oracleUrl}/readings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(signed),
  });
  return (await res.json()) as OracleResponse;
}
