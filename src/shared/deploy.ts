import type { Signer } from "ethers";
import { EnergyMarketplace__factory, EnergyToken__factory, MockStablecoin__factory } from "../../typechain-types";
import type { Deployment, ParticipantRecord } from "./chain";
import { CONSUMER_STARTING_USD, maxExportWh, maxImportWh, meterKey, type ParticipantSpec } from "./participants";
import { USD } from "./units";

export interface DeployOptions {
  admin: Signer;
  oracle: string;
  participants: { spec: ParticipantSpec; wallet: string }[];
  rpcUrl: string;
  simDate: string;
}

/**
 * Deploy the three contracts, grant the oracle role, register every meter with
 * its rated capacity, and fund consumers with mock stablecoin.
 */
export async function deployMarketplace(opts: DeployOptions): Promise<Deployment> {
  const { admin } = opts;
  const adminAddress = await admin.getAddress();
  const provider = admin.provider!;

  const stable = await new MockStablecoin__factory(admin).deploy(adminAddress);
  const token = await new EnergyToken__factory(admin).deploy(adminAddress);
  await Promise.all([stable.waitForDeployment(), token.waitForDeployment()]);
  const market = await new EnergyMarketplace__factory(admin).deploy(
    adminAddress,
    await token.getAddress(),
    await stable.getAddress(),
  );
  await market.waitForDeployment();

  await (await token.grantRole(await token.ORACLE_ROLE(), opts.oracle)).wait();

  const records: ParticipantRecord[] = [];
  for (const { spec, wallet } of opts.participants) {
    const meter = meterKey(spec.id).address;
    await (await token.registerMeter(meter, wallet, maxExportWh(spec), maxImportWh(spec))).wait();
    const startingUsd = spec.role === "consumer" ? CONSUMER_STARTING_USD : 0;
    if (startingUsd > 0) await (await stable.mint(wallet, BigInt(startingUsd) * USD)).wait();
    records.push({
      id: spec.id,
      role: spec.role,
      label: spec.label,
      wallet,
      meter,
      pvKw: spec.pvKw,
      batteryKwh: spec.battery?.capacityKwh ?? 0,
      maxExportWh: maxExportWh(spec),
      maxImportWh: maxImportWh(spec),
      startingUsd,
    });
  }

  return {
    chainId: Number((await provider.getNetwork()).chainId),
    rpcUrl: opts.rpcUrl,
    simDate: opts.simDate,
    contracts: {
      energyToken: await token.getAddress(),
      marketplace: await market.getAddress(),
      stablecoin: await stable.getAddress(),
    },
    admin: adminAddress,
    oracle: opts.oracle,
    participants: records,
  };
}
