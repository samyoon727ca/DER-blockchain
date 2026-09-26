import { expect } from "chai";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { isReadOnly, startDashboard } from "../src/dashboard/server";
import type { Deployment } from "../src/shared/chain";

const call = (method: unknown) => ({ jsonrpc: "2.0", id: 1, method, params: [] });

describe("Dashboard RPC proxy", () => {
  describe("read-only allowlist", () => {
    it("allows reads, alone or batched", () => {
      expect(isReadOnly(JSON.stringify(call("eth_call")))).to.equal(true);
      expect(isReadOnly(JSON.stringify([call("eth_getLogs"), call("eth_blockNumber")]))).to.equal(true);
    });

    it("refuses anything that can change chain state, including inside a batch", () => {
      for (const method of ["eth_sendTransaction", "eth_sendRawTransaction", "eth_sign", "hardhat_setBalance", "evm_mine", "evm_setAutomine"]) {
        expect(isReadOnly(JSON.stringify(call(method))), method).to.equal(false);
        expect(isReadOnly(JSON.stringify([call("eth_call"), call(method)])), `batch with ${method}`).to.equal(false);
      }
    });

    it("refuses malformed requests", () => {
      for (const body of ["", "not json", "[]", "null", "[null]", "42", JSON.stringify(call(42)), JSON.stringify({ params: [] })]) {
        expect(isReadOnly(body), body).to.equal(false);
      }
    });
  });

  describe("server", () => {
    let upstream: http.Server;
    let dashboard: http.Server;
    let forwarded: string[];
    let rpc: string;

    before(async () => {
      forwarded = [];
      // Stands in for the chain: records whatever the proxy forwards.
      upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          forwarded.push(Buffer.concat(chunks).toString("utf8"));
          res.writeHead(200, { "content-type": "application/json" }).end('{"jsonrpc":"2.0","id":1,"result":"0x1"}');
        });
      });
      await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
      const deployment = { chainId: 31337, contracts: {}, participants: [] } as unknown as Deployment;
      dashboard = await startDashboard({
        port: 0,
        rpcUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
        oracleUrl: "http://127.0.0.1:1",
        deployment,
        demoState: () => ({}),
      });
      rpc = `http://127.0.0.1:${(dashboard.address() as AddressInfo).port}/rpc`;
    });

    after(() => {
      dashboard.close();
      upstream.close();
    });

    const post = (body: string) => fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body });

    it("forwards reads to the chain", async () => {
      const res = await post(JSON.stringify(call("eth_blockNumber")));
      expect(res.status).to.equal(200);
      expect(forwarded).to.have.length(1);
    });

    it("answers 403 to writes and never forwards them", async () => {
      forwarded.length = 0;
      const res = await post(JSON.stringify([call("eth_blockNumber"), call("eth_sendTransaction")]));
      expect(res.status).to.equal(403);
      expect(forwarded).to.have.length(0);
    });

    it("answers 413 to oversized bodies without buffering them", async () => {
      forwarded.length = 0;
      const res = await post(JSON.stringify({ ...call("eth_call"), params: ["x".repeat(128 * 1024)] }));
      expect(res.status).to.equal(413);
      expect(forwarded).to.have.length(0);
    });
  });
});
