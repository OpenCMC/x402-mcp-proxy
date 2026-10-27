import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { x402Client } from "@x402/axios";
import { NETWORK_CASPER_MAINNET, NETWORK_CASPER_TESTNET } from "@make-software/casper-x402";
import {
  CASPER_NETWORK_MAINNET,
  CASPER_NETWORK_TESTNET,
  parseCasperPrivateKey,
  registerCasperScheme,
} from "../src/casper.js";
import { loadPaymentLimits } from "../src/limits.js";

// Throwaway test keys — never fund these.
const ED25519_KEY = "01" + "11".repeat(32);
const SECP256K1_KEY = "02" + "22".repeat(32);
const EVM_KEY = "0x" + "ab".repeat(32);

const ASSET = "aa".repeat(32);
const PAY_TO = "00" + "bb".repeat(32);

function casperPaymentRequired(network: string) {
  return {
    x402Version: 2,
    resource: { url: "https://mcp.example.com/mcp", description: "test", mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: network as `${string}:${string}`,
        asset: ASSET,
        amount: "1000",
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { name: "Wrapped CSPR", version: "1" },
      },
    ],
  };
}

test("CAIP-2 ids match the casper-x402 package constants", () => {
  assert.equal(CASPER_NETWORK_MAINNET, "casper:casper");
  assert.equal(CASPER_NETWORK_TESTNET, "casper:casper-test");
  assert.equal(CASPER_NETWORK_MAINNET, NETWORK_CASPER_MAINNET);
  assert.equal(CASPER_NETWORK_TESTNET, NETWORK_CASPER_TESTNET);
});

test("parseCasperPrivateKey accepts Ed25519 (01) and secp256k1 (02) hex keys", () => {
  const ed = parseCasperPrivateKey(ED25519_KEY);
  assert.match(ed.publicKey.toHex(), /^01[0-9a-f]{64}$/);

  const secp = parseCasperPrivateKey(`  ${SECP256K1_KEY}\n`);
  assert.match(secp.publicKey.toHex(), /^02[0-9a-f]{66}$/);
});

test("parseCasperPrivateKey rejects 0x-prefixed EVM keys with a clear error", () => {
  assert.throws(() => parseCasperPrivateKey(EVM_KEY), /looks like an EVM key \(0x-prefixed\)/);
  assert.throws(() => parseCasperPrivateKey("0X" + "ab".repeat(32)), /looks like an EVM key/);
});

test("parseCasperPrivateKey rejects malformed keys", () => {
  for (const bad of ["", "11".repeat(32), "03" + "11".repeat(32), "01" + "11".repeat(31), "01" + "zz".repeat(32)]) {
    assert.throws(() => parseCasperPrivateKey(bad), /CASPER_PRIVATE_KEY is invalid/, bad);
  }
});

test("casper:* scheme is registered when CASPER_PRIVATE_KEY is set", async () => {
  const client = new x402Client();
  assert.equal(registerCasperScheme(client, ED25519_KEY), true);

  const expectedPublicKey = parseCasperPrivateKey(ED25519_KEY).publicKey;

  for (const network of [CASPER_NETWORK_MAINNET, CASPER_NETWORK_TESTNET]) {
    const payload = await client.createPaymentPayload(casperPaymentRequired(network));
    assert.equal(payload.accepted.scheme, "exact");
    assert.equal(payload.accepted.network, network);

    const inner = payload.payload as {
      signature: string;
      publicKey: string;
      authorization: { from: string; to: string; value: string };
    };
    assert.equal(inner.publicKey, expectedPublicKey.toHex());
    assert.equal(inner.authorization.from, "00" + expectedPublicKey.accountHash().toHex());
    assert.equal(inner.authorization.to, PAY_TO);
    assert.equal(inner.authorization.value, "1000");
    assert.match(inner.signature, /^01[0-9a-f]{128}$/);
  }
});

test("casper:* scheme is NOT registered when CASPER_PRIVATE_KEY is absent", async () => {
  const client = new x402Client();
  assert.equal(registerCasperScheme(client, undefined), false);
  assert.equal(registerCasperScheme(client, ""), false);
  await assert.rejects(client.createPaymentPayload(casperPaymentRequired(CASPER_NETWORK_TESTNET)));
});

test("default payment limits are unchanged (no Casper network or asset)", () => {
  const limits = loadPaymentLimits({});
  assert.deepEqual(
    [...limits.allowedNetworks],
    ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
  );
  assert.deepEqual(
    [...limits.allowedAssets],
    ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
  );
  assert.equal(limits.maxPerRequest, 100000n);
  assert.equal(limits.maxPerSession, 1000000n);
});

test("X402_ALLOWED_NETWORKS accepts casper:casper and casper:casper-test", () => {
  const limits = loadPaymentLimits({
    X402_ALLOWED_NETWORKS: "eip155:8453, casper:casper ,casper:casper-test",
    X402_ALLOWED_ASSETS: ASSET,
  });
  assert.ok(limits.allowedNetworks.has("casper:casper"));
  assert.ok(limits.allowedNetworks.has("casper:casper-test"));
  assert.ok(limits.allowedNetworks.has("eip155:8453"));
  assert.ok(limits.allowedAssets.has(ASSET));
});

test("proxy exits with a clear error when CASPER_PRIVATE_KEY is an EVM key", () => {
  const env: NodeJS.ProcessEnv = { ...process.env, CASPER_PRIVATE_KEY: EVM_KEY, X402_REMOTE_MCPS: "t,http://127.0.0.1:9/mcp" };
  delete env.EVM_PRIVATE_KEY;
  delete env.SVM_PRIVATE_KEY;
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
    env,
    encoding: "utf-8",
    timeout: 30_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /\[x402-proxy\] Fatal: CASPER_PRIVATE_KEY looks like an EVM key/);
});
