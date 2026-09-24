/**
 * End-to-end demo: one simulated day of a neighbourhood energy marketplace.
 *
 *   npm run demo           paced so you can watch the dashboard, keeps running at the end
 *   npm run demo:fast      no pacing, exits when the report is written
 *
 * Steps: start a local Hardhat chain -> deploy and register meters -> start the
 * oracle and dashboard -> for each 15-minute interval: meters sign readings and
 * POST them to the oracle, which settles them on-chain; prosumers list credits,
 * consumers buy them; security scenarios are injected along the way -> write the
 * settlement report.
 *
 * Environment: SIM_DATE (default 2026-06-21), DEMO_INTERVAL_MS (default 350),
 * RPC_PORT (8545), ORACLE_PORT (8600), DASHBOARD_PORT (3000).
 */
import fs from "node:fs";
import type http from "node:http";
import { ConsumerAgent, OrderBook, ProsumerAgent, type MarketEvent } from "../src/market/agents";
import { sendToOracle } from "../src/meter-simulator/meter";
import type { IntervalFlows } from "../src/meter-simulator/physics";
import { NeighbourhoodSimulator } from "../src/meter-simulator/simulator";
import { Oracle } from "../src/oracle/oracle";
import { startOracleServer } from "../src/oracle/server";
import { SCENARIOS, type Phase, type ScenarioContext, type ScenarioOutcome } from "../src/scenarios/security";
import { buildSettlement, renderMarkdown, saveReport, telemetryPath } from "../src/settlement/report";
import { REPORTS_DIR, connectContracts, rpcProvider, saveDeployment, DEPLOYMENT_FILE } from "../src/shared/chain";
import { deployMarketplace } from "../src/shared/deploy";
import { ACCOUNT_INDEX, PARTICIPANTS, hardhatWallet } from "../src/shared/participants";
import { INTERVALS_PER_DAY, INTERVAL_SECONDS, readingDomain, type SignedReading } from "../src/shared/reading";
import { formatKwh, formatUsd, hhmm } from "../src/shared/units";
import { startDashboard } from "../src/dashboard/server";

const args = new Set(process.argv.slice(2));
const FAST = args.has("--fast");
const EXIT_WHEN_DONE = args.has("--exit");
const INTERVAL_DELAY_MS = FAST ? 0 : Number(process.env.DEMO_INTERVAL_MS ?? 350);
const SIM_DATE = process.env.SIM_DATE ?? "2026-06-21";
const RPC_PORT = Number(process.env.RPC_PORT ?? 8545);
const ORACLE_PORT = Number(process.env.ORACLE_PORT ?? 8600);
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT ?? 3000);

const tty = process.stdout.isTTY;
const color = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = color(1);
const dim = color(2);
const green = color(32);
const red = color(31);
const yellow = color(33);
const cyan = color(36);

interface HouseholdLive extends IntervalFlows {
  intervalStart: number;
  oracleStatus: string;
}

/** Off-chain state the dashboard shows next to what it reads from the chain. */
const demo = {
  phase: "starting" as "starting" | "running" | "complete",
  simDate: SIM_DATE,
  dayStart: 0,
  intervalIndex: -1,
  intervalsTotal: INTERVALS_PER_DAY,
  households: {} as Record<string, HouseholdLive>,
  scenarios: [] as ScenarioOutcome[],
  marketLog: [] as (MarketEvent & { at: number })[],
  reportFile: null as string | null,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startChain(dayStart: number): Promise<{ close(): Promise<void> }> {
  // The chain clock has to start before the simulated day (it can only move forward).
  process.env.SIM_GENESIS_DATE = new Date((dayStart - 86_400) * 1000).toISOString();
  const hre = (await import("hardhat")).default;
  const { TASK_NODE_CREATE_SERVER } = await import("hardhat/builtin-tasks/task-names");
  const server = await hre.run(TASK_NODE_CREATE_SERVER, {
    hostname: "127.0.0.1",
    port: RPC_PORT,
    provider: hre.network.provider,
  });
  await server.listen();
  return server;
}

function recordScenario(outcome: ScenarioOutcome): void {
  // Multi-step scenarios (the pause) report under one title.
  const existing = demo.scenarios.find((s) => s.title === outcome.title);
  if (existing) existing.steps.push(...outcome.steps);
  else demo.scenarios.push(outcome);

  const header = outcome.threat
    ? `${bold(yellow(`[${hhmm(outcome.at)}] SECURITY: ${outcome.title}`))} ${dim(`— ${outcome.threat}`)}`
    : bold(yellow(`[${hhmm(outcome.at)}] SECURITY: ${outcome.title} (continued)`));
  console.log(`\n  ${header}`);
  for (const step of outcome.steps) {
    const mark = step.blocked ? green("✔") : red("✘");
    console.log(`    ${mark} ${step.action}\n      ${dim("→")} ${step.blocked ? step.result : red(step.result)}`);
  }
  console.log();
}

function closeServer(server: { close(cb?: () => void): unknown } | undefined): Promise<void> {
  return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
}

async function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(SIM_DATE)) throw new Error(`SIM_DATE must be YYYY-MM-DD, got "${SIM_DATE}"`);
  const dayStart = Date.parse(`${SIM_DATE}T00:00:00Z`) / 1000;
  demo.dayStart = dayStart;

  console.log(bold("\nDistributed energy marketplace — proof of concept"));
  console.log(dim(`Simulated day ${SIM_DATE} (UTC clock) · 5 prosumers + 5 consumers · 96 × 15-minute intervals\n`));

  // 1. Local chain ----------------------------------------------------------
  const chain = await startChain(dayStart).catch((err) => {
    throw new Error(`Could not start the local chain on port ${RPC_PORT} (${err.message}). Set RPC_PORT to use another port.`);
  });
  const rpcUrl = `http://127.0.0.1:${RPC_PORT}`;
  const provider = rpcProvider(rpcUrl);

  const admin = hardhatWallet(ACCOUNT_INDEX.admin, provider);
  const oracleWallet = hardhatWallet(ACCOUNT_INDEX.oracle, provider);
  const attackerWallet = hardhatWallet(ACCOUNT_INDEX.attacker, provider);
  const wallets = new Map(PARTICIPANTS.map((p) => [p.id, hardhatWallet(p.accountIndex, provider)]));

  // 2. Deploy -----------------------------------------------------------------
  const deployment = await deployMarketplace({
    admin,
    oracle: oracleWallet.address,
    participants: PARTICIPANTS.map((spec) => ({ spec, wallet: wallets.get(spec.id)!.address })),
    rpcUrl,
    simDate: SIM_DATE,
  });
  saveDeployment(deployment);
  const domain = readingDomain(deployment.chainId, deployment.contracts.energyToken);
  const adminContracts = connectContracts(deployment, admin);

  // 3. Services ---------------------------------------------------------------
  const oracle = new Oracle(connectContracts(deployment, oracleWallet).token, provider, domain);
  oracle.start();
  const oracleServer = await startOracleServer(oracle, ORACLE_PORT);
  const oracleUrl = `http://127.0.0.1:${ORACLE_PORT}`;
  const dashboard = await startDashboard({ port: DASHBOARD_PORT, rpcUrl, oracleUrl, deployment, demoState: () => demo });

  const rows: [string, string][] = [
    ["Local chain", `${rpcUrl} (chainId ${deployment.chainId})`],
    ["EnergyToken", deployment.contracts.energyToken],
    ["EnergyMarketplace", deployment.contracts.marketplace],
    ["MockStablecoin", deployment.contracts.stablecoin],
    ["Oracle service", `${oracleUrl} (signer ${oracleWallet.address})`],
    ["Meters registered", `${deployment.participants.length}`],
    ["Deployment file", DEPLOYMENT_FILE.replace(process.cwd() + "/", "")],
  ];
  for (const [k, v] of rows) console.log(`  ${k.padEnd(18)} ${v}`);
  console.log(`  ${"Dashboard".padEnd(18)} ${bold(cyan(`http://localhost:${DASHBOARD_PORT}`))}  ← open this\n`);

  // 4. Participants -------------------------------------------------------------
  const sim = new NeighbourhoodSimulator(PARTICIPANTS, domain, dayStart);
  const book = new OrderBook(connectContracts(deployment, provider).market);
  const participantContracts = new Map(PARTICIPANTS.map((p) => [p.id, connectContracts(deployment, wallets.get(p.id)!)]));
  const prosumers = PARTICIPANTS.filter((p) => p.role === "prosumer").map((spec) => {
    const c = participantContracts.get(spec.id)!;
    return new ProsumerAgent(spec, wallets.get(spec.id)!.address, c.token, c.market);
  });
  const consumers = PARTICIPANTS.filter((p) => p.role === "consumer").map((spec) => {
    const c = participantContracts.get(spec.id)!;
    return new ConsumerAgent(spec, wallets.get(spec.id)!.address, c.token, c.stable, c.market, dayStart);
  });
  await Promise.all([...prosumers, ...consumers].map((a) => a.approve()));

  const lastSettled = new Map<string, SignedReading>();
  const scenarioCtx: ScenarioContext = {
    deployment,
    domain,
    provider,
    oracleUrl,
    sim,
    book,
    admin: adminContracts,
    oracleKey: connectContracts(deployment, oracleWallet),
    attacker: { wallet: attackerWallet, contracts: connectContracts(deployment, attackerWallet) },
    participants: new Map(PARTICIPANTS.map((p) => [p.id, { wallet: wallets.get(p.id)!, contracts: participantContracts.get(p.id)! }])),
    lastSettled,
    drainOracle: async () => {
      const before = oracle.stats.settled;
      await oracle.drain();
      return oracle.stats.settled - before;
    },
  };
  const runScenarios = async (interval: number, phase: Phase, intervalStart: number) => {
    for (const hook of SCENARIOS.filter((s) => s.interval === interval && s.phase === phase)) {
      const outcome = await hook.run(scenarioCtx, intervalStart);
      if (outcome) recordScenario(outcome);
    }
  };

  // 5. The simulated day ------------------------------------------------------------
  demo.phase = "running";
  console.log(dim("  Hour         Export   Import   Minted   Burned   Listings   Trades                  Oracle"));
  let hour = { exported: 0, imported: 0, minted: 0, burned: 0, listed: 0, trades: 0, tradedWh: 0n, spent: 0n, ok: 0, queued: 0, rejected: 0 };

  for (let i = 0; i < INTERVALS_PER_DAY; i++) {
    const intervalStart = sim.intervalStart(i);
    const intervalEnd = intervalStart + INTERVAL_SECONDS;
    demo.intervalIndex = i;

    // Advance the chain clock to the end of the interval being reported.
    const latest = (await provider.getBlock("latest"))!.timestamp;
    await provider.send("evm_setNextBlockTimestamp", [Math.max(intervalEnd + 5, latest + 1)]);
    await provider.send("evm_mine", []);

    await runScenarios(i, "before-readings", intervalStart);

    // Meters sign their readings and send them to the oracle concurrently.
    const outputs = await sim.readInterval(i);
    const responses = await Promise.all(outputs.map((o) => sendToOracle(oracleUrl, o.signed)));
    outputs.forEach((o, k) => {
      const res = responses[k];
      demo.households[o.participant.id] = { ...o.flows, intervalStart, oracleStatus: res.status };
      if (res.status === "settled") lastSettled.set(o.participant.id, o.signed);
      if (res.status === "rejected") console.log(red(`  oracle rejected ${o.participant.id}: ${res.code} ${res.detail ?? ""}`));
      hour.exported += o.flows.exportedWh;
      hour.imported += o.flows.importedWh;
      hour.minted += res.mintedWh ?? 0;
      hour.burned += res.burnedWh ?? 0;
      if (res.status === "settled") hour.ok++;
      else if (res.status === "queued") hour.queued++;
      else hour.rejected++;
    });

    await runScenarios(i, "after-readings", intervalStart);

    // Market: prosumers list new credits, consumers buy (rotating who goes first).
    if (!(await adminContracts.token.paused())) {
      const now = intervalEnd;
      const events: MarketEvent[] = [];
      await book.sync();
      for (const p of prosumers) events.push(...(await p.act(now, i % 4 === 3)));
      await book.sync();
      for (let k = 0; k < consumers.length; k++) {
        events.push(...(await consumers[(i + k) % consumers.length].act(now, book)));
      }
      for (const e of events) {
        demo.marketLog.push({ ...e, at: intervalStart });
        if (e.kind === "listed") hour.listed++;
        if (e.kind === "bought") {
          hour.trades++;
          hour.tradedWh += e.amountWh!;
          hour.spent += e.cost!;
        }
      }
      if (demo.marketLog.length > 200) demo.marketLog.splice(0, demo.marketLog.length - 200);
    }

    if (i % 4 === 3) {
      const h = hhmm(intervalEnd - 3600);
      const trades = `${hour.trades} (${formatKwh(hour.tradedWh, 1)} kWh, $${formatUsd(hour.spent)})`;
      const oracleCol = `${hour.ok} settled` + (hour.queued ? yellow(`, ${hour.queued} queued`) : "") + (hour.rejected ? red(`, ${hour.rejected} rejected`) : "");
      console.log(
        `  ${h}–${hhmm(intervalEnd) === "00:00" ? "24:00" : hhmm(intervalEnd)}  ` +
          [hour.exported, hour.imported, hour.minted, hour.burned].map((wh) => formatKwh(wh, 1).padStart(6)).join("   ") +
          `   ${String(hour.listed).padStart(8)}   ${trades.padEnd(22)}  ${oracleCol}`,
      );
      hour = { exported: 0, imported: 0, minted: 0, burned: 0, listed: 0, trades: 0, tradedWh: 0n, spent: 0n, ok: 0, queued: 0, rejected: 0 };
    }

    if (INTERVAL_DELAY_MS > 0) await sleep(INTERVAL_DELAY_MS);
  }

  // 6. Settlement ------------------------------------------------------------------
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const telemetry = Object.fromEntries([...sim.telemetry].map(([id, t]) => [id, { pvWh: t.pvWh, loadWh: t.loadWh }]));
  fs.writeFileSync(telemetryPath(SIM_DATE), JSON.stringify(telemetry, null, 2));
  const report = await buildSettlement(deployment, provider, telemetry);
  demo.reportFile = saveReport(report);
  demo.phase = "complete";

  console.log("\n" + renderMarkdown(report));
  const blocked = demo.scenarios.flatMap((s) => s.steps).filter((s) => !s.blocked).length === 0;
  const checksOk = report.checks.every((c) => c.ok);
  console.log(
    `${checksOk ? green("✔") : red("✘")} integrity checks ${checksOk ? "passed" : "FAILED"} · ` +
      `${blocked ? green("✔") : red("✘")} ${demo.scenarios.length} security scenarios ${blocked ? "handled safely" : "had FAILURES"}`,
  );
  console.log(`Report saved to ${demo.reportFile.replace(process.cwd() + "/", "")} (+ .json)\n`);

  const shutdown = async (code: number) => {
    oracle.stop();
    provider.destroy();
    await Promise.all([closeServer(oracleServer), closeServer(dashboard as http.Server), chain.close()]);
    process.exit(code);
  };
  const exitCode = checksOk && blocked ? 0 : 1;
  if (EXIT_WHEN_DONE) return shutdown(exitCode);

  console.log(bold(`Dashboard still live at http://localhost:${DASHBOARD_PORT} — run "npm run report" in another terminal to re-read the chain.`));
  console.log(dim("Press Ctrl+C to stop the chain and services."));
  process.on("SIGINT", () => void shutdown(exitCode));
  process.on("SIGTERM", () => void shutdown(exitCode));
}

main().catch((err) => {
  console.error(red(`\nDemo failed: ${err instanceof Error ? err.stack ?? err.message : err}`));
  process.exit(1);
});
