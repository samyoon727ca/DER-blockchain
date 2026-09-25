/**
 * Settlement report for the simulated period.
 *
 *   npm run report
 *
 * Reads every reading, mint, burn, listing and trade event from the chain the
 * demo is running (see deployments/localhost.json), prints the report and
 * writes reports/settlement-<date>.md and .json. The demo runs this
 * automatically at the end of the simulated day.
 */
import { loadDeployment, rpcProvider } from "../src/shared/chain";
import { buildSettlement, loadTelemetry, renderMarkdown, saveReport } from "../src/settlement/report";

async function main() {
  const deployment = loadDeployment();
  const provider = rpcProvider(deployment.rpcUrl);
  try {
    await provider.getBlockNumber();
  } catch {
    throw new Error(`Cannot reach the local chain at ${deployment.rpcUrl}. Is "npm run demo" still running?`);
  }
  const report = await buildSettlement(deployment, provider, loadTelemetry(deployment.simDate));
  console.log(renderMarkdown(report));
  console.log(`Saved ${saveReport(report)}`);
  provider.destroy();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
