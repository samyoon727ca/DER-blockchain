/** EnergyToken has 3 decimals: 1 base unit = 1 Wh, 1 token = 1 kWh. */
export const WH_PER_KWH = 1000;
/** MockStablecoin has 6 decimals, like USDC. */
export const USD_DECIMALS = 6;
export const USD = 10n ** BigInt(USD_DECIMALS);

/** Price in stablecoin base units per kWh, from dollars (e.g. 0.14 -> 140000n). */
export function usdPerKwh(dollars: number): bigint {
  return BigInt(Math.round(dollars * Number(USD)));
}

export function formatKwh(wh: bigint | number, digits = 2): string {
  return (Number(wh) / WH_PER_KWH).toFixed(digits);
}

export function formatUsd(units: bigint | number, digits = 2): string {
  return (Number(units) / Number(USD)).toFixed(digits);
}

/** Cost the marketplace charges (mirrors EnergyMarketplace.quote: rounded up). */
export function quote(pricePerKwh: bigint, amountWh: bigint): bigint {
  return (amountWh * pricePerKwh + BigInt(WH_PER_KWH) - 1n) / BigInt(WH_PER_KWH);
}

export function hhmm(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(11, 16);
}
