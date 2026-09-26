import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { ROOT_DIR, type Deployment } from "../shared/chain";
import { BodyTooLarge, readBody } from "../shared/http";
import { TARIFFS } from "../shared/participants";

export interface DashboardOptions {
  port: number;
  rpcUrl: string;
  oracleUrl: string;
  deployment: Deployment;
  /** Live, off-chain demo state (simulated clock, household telemetry, scenario outcomes). */
  demoState: () => unknown;
}

const PUBLIC_DIR = path.join(__dirname, "public");

/** The dashboard is read-only: the RPC proxy refuses anything that could change chain state. */
const READ_ONLY_RPC = new Set([
  "eth_chainId",
  "net_version",
  "eth_blockNumber",
  "eth_call",
  "eth_getLogs",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getBalance",
  "eth_getCode",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
]);

/** The dashboard's own requests are a few hundred bytes; anything this big is refused unread. */
const MAX_RPC_BODY_BYTES = 64 * 1024;

export function isReadOnly(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { method?: unknown } | { method?: unknown }[];
    const calls = Array.isArray(parsed) ? parsed : [parsed];
    return calls.length > 0 && calls.every((c) => typeof c.method === "string" && READ_ONLY_RPC.has(c.method));
  } catch {
    return false;
  }
}

const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: path.join(PUBLIC_DIR, "index.html"), type: "text/html; charset=utf-8" },
  "/app.js": { file: path.join(PUBLIC_DIR, "app.js"), type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: path.join(PUBLIC_DIR, "styles.css"), type: "text/css; charset=utf-8" },
  "/vendor/ethers.umd.min.js": {
    file: path.join(ROOT_DIR, "node_modules", "ethers", "dist", "ethers.umd.min.js"),
    type: "text/javascript; charset=utf-8",
  },
};

function abiOf(contract: string): unknown {
  const file = path.join(ROOT_DIR, "artifacts", "contracts", `${contract}.sol`, `${contract}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8")).abi;
}

/**
 * Serves the dashboard and proxies JSON-RPC to the local chain, so the browser
 * reads balances, listings and events straight from the contracts.
 */
export function startDashboard(opts: DashboardOptions): Promise<http.Server> {
  const config = JSON.stringify({
    deployment: opts.deployment,
    tariffs: TARIFFS,
    abis: {
      EnergyToken: abiOf("EnergyToken"),
      EnergyMarketplace: abiOf("EnergyMarketplace"),
      MockStablecoin: abiOf("MockStablecoin"),
    },
  });

  const server = http.createServer(async (req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    const json = (code: number, body: string) => {
      res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body);
    };
    try {
      if (req.method === "GET" && STATIC[url]) {
        res.writeHead(200, { "content-type": STATIC[url].type, "cache-control": "no-store" });
        return fs.createReadStream(STATIC[url].file).pipe(res);
      }
      if (req.method === "GET" && url === "/api/config") return json(200, config);
      if (req.method === "GET" && url === "/api/demo") {
        return json(200, JSON.stringify(opts.demoState(), (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
      }
      if (req.method === "GET" && url === "/api/oracle") {
        const upstream = await fetch(`${opts.oracleUrl}/status`);
        return json(upstream.status, await upstream.text());
      }
      if (req.method === "POST" && url === "/rpc") {
        const body = await readBody(req, MAX_RPC_BODY_BYTES);
        if (!isReadOnly(body)) return json(403, JSON.stringify({ error: "dashboard RPC proxy is read-only" }));
        const upstream = await fetch(opts.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
        return json(upstream.status, await upstream.text());
      }
      res.writeHead(404).end("not found");
    } catch (err) {
      json(err instanceof BodyTooLarge ? 413 : 502, JSON.stringify({ error: (err as Error).message }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => resolve(server));
  });
}
