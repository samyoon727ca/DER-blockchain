import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "@typechain/hardhat";

// `npm run demo` should never stop to ask an interactive question. Hardhat's
// first-run telemetry prompt is skipped (no consent recorded = nothing sent).
process.env.HARDHAT_DISABLE_TELEMETRY_PROMPT ??= "true";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      // The demo simulates a fixed calendar day, so the local chain's clock must
      // start before it (chain time can only move forward). scripts/demo.ts sets
      // SIM_GENESIS_DATE to the day before SIM_DATE.
      initialDate: process.env.SIM_GENESIS_DATE ?? "2026-06-20T00:00:00Z",
    },
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
};

export default config;
