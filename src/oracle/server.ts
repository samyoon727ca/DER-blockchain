import http from "node:http";
import type { Oracle } from "./oracle";

const MAX_BODY_BYTES = 16 * 1024;

/**
 * HTTP front door for meters:
 *   POST /readings  {reading, signature} -> 200 settled | 202 queued | 422 rejected
 *   GET  /status    counters and the most recent decisions (used by the dashboard)
 */
export function startOracleServer(oracle: Oracle, port: number, host = "127.0.0.1"): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const send = (code: number, payload: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    try {
      if (req.method === "POST" && req.url === "/readings") {
        const body = await readBody(req);
        let json: unknown;
        try {
          json = JSON.parse(body);
        } catch {
          json = undefined;
        }
        const result = await oracle.handle(json);
        return send(result.status === "settled" ? 200 : result.status === "queued" ? 202 : 422, result);
      }
      if (req.method === "GET" && req.url === "/status") return send(200, oracle.status());
      if (req.method === "GET" && req.url === "/health") return send(200, { ok: true });
      send(404, { error: "not found" });
    } catch (err) {
      send(500, { error: (err as Error).message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
