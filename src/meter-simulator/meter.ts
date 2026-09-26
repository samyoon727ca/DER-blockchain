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

/**
 * Deliver a signed reading to the oracle over HTTP, as a meter's uplink would.
 * An error response without a decision (e.g. a 500) is reported as a rejection
 * carrying the HTTP status, rather than as a decision the oracle never made.
 */
export async function sendToOracle(oracleUrl: string, signed: SignedReading): Promise<OracleResponse> {
  const res = await fetch(`${oracleUrl}/readings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(signed),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<OracleResponse> & { error?: string };
  if (body.status === "settled" || body.status === "queued" || body.status === "rejected") return body as OracleResponse;
  return { status: "rejected", code: `HTTP_${res.status}`, detail: body.error ?? res.statusText };
}
