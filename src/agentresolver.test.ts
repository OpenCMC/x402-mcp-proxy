import assert from "node:assert/strict";
import test from "node:test";
import {
  agentResolverGuardEnabled,
  assertAgentResolverGuard,
  bindGuardedRequirement,
  selectGuardRequirement,
} from "./agentresolver.js";

test("AgentResolver Guard is opt-in", () => {
  assert.equal(agentResolverGuardEnabled({}), false);
  assert.equal(agentResolverGuardEnabled({ AGENTRESOLVER_GUARD: "1" }), true);
});

test("selects the first exact requirement supported by a configured wallet", () => {
  const selected = selectGuardRequirement(
    [
      {
        scheme: "exact",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        payTo: "11111111111111111111111111111111",
        amount: "1000",
      },
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x0000000000000000000000000000000000000001",
        amount: "1000",
      },
    ],
    { evm: true, svm: false },
  );

  assert.equal(selected?.network, "eip155:8453");
});

test("does not select requirements with missing scheme or payment identity", () => {
  const incomplete = [
    {
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x0000000000000000000000000000000000000001",
      amount: "1000",
    },
    {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "1000",
    },
  ];

  assert.equal(
    selectGuardRequirement(incomplete, { evm: true, svm: false }),
    null,
  );
});

test("binds signing to only the Guard-approved requirement", () => {
  const first = {
    scheme: "exact",
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0x0000000000000000000000000000000000000001",
    amount: "1000",
  };
  const approved = {
    ...first,
    payTo: "0x0000000000000000000000000000000000000002",
  };
  const paymentRequired = {
    x402Version: 2,
    resource: { url: "https://merchant.example/mcp" },
    accepts: [first, approved],
  };

  const narrowed = bindGuardedRequirement(paymentRequired, approved);

  assert.equal(narrowed.accepts.length, 1);
  assert.equal(
    narrowed.accepts[0].payTo,
    "0x0000000000000000000000000000000000000002",
  );
  assert.equal(paymentRequired.accepts.length, 2);
});

test("accepts matching eligible Guard evidence", async () => {
  const captured: { body?: Record<string, unknown> } = {};
  const guardFetch = (async (_input, init) => {
    captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        observation: {
          mode: "caller-observed-challenge",
          observedStatus: 402,
          safeProbeMethod: "HEAD",
          safeProbeStatus: 405,
          targetRequestReplayed: false,
        },
        prepaymentDecision: {
          decision: "eligible",
          eligibleForCallerAuthorization: true,
          targetPayment: {
            network: "eip155:8453",
            asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
            payTo: "0x0000000000000000000000000000000000000001",
            amountAtomic: "1000",
            scheme: "exact",
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;

  await assertAgentResolverGuard({
    guardFetch,
    requestUrl: "https://merchant.example/mcp",
    method: "POST",
    paymentRequired: {
      x402Version: 2,
      resource: { url: "https://merchant.example/mcp" },
      accepts: [{
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x0000000000000000000000000000000000000001",
        amount: "1000",
      }],
    },
    requirement: {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x0000000000000000000000000000000000000001",
      amount: "1000",
    },
    env: {},
  });

  assert.equal(captured.body?.url, "https://merchant.example/mcp");
  assert.equal(captured.body?.method, "POST");
  assert.equal(captured.body?.observedStatus, 402);
  assert.equal(
    (captured.body?.observedPaymentRequired as any)?.accepts?.[0]?.amount,
    "1000",
  );
  assert.equal(captured.body?.allowUnpaidPostProbe, undefined);
  assert.equal(captured.body?.body, undefined);
});

test("fails closed when returned evidence no longer matches payTo", async () => {
  const guardFetch = (async () =>
    new Response(
      JSON.stringify({
        observation: {
          mode: "caller-observed-challenge",
          observedStatus: 402,
          safeProbeMethod: "HEAD",
          safeProbeStatus: 405,
          targetRequestReplayed: false,
        },
        prepaymentDecision: {
          decision: "eligible",
          eligibleForCallerAuthorization: true,
          targetPayment: {
            network: "eip155:8453",
            asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
            payTo: "0x0000000000000000000000000000000000000002",
            amountAtomic: "1000",
            scheme: "exact",
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof globalThis.fetch;

  await assert.rejects(
    assertAgentResolverGuard({
      guardFetch,
      requestUrl: "https://merchant.example/mcp",
      method: "GET",
      paymentRequired: {
        x402Version: 2,
        resource: { url: "https://merchant.example/mcp" },
        accepts: [{
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x0000000000000000000000000000000000000001",
          amount: "1000",
        }],
      },
      requirement: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x0000000000000000000000000000000000000001",
        amount: "1000",
      },
      env: {},
    }),
    /evidence mismatch for payTo/,
  );
});

test("fails closed if Guard does not confirm supplied-challenge mode", async () => {
  const guardFetch = (async () =>
    new Response(
      JSON.stringify({
        prepaymentDecision: {
          decision: "eligible",
          eligibleForCallerAuthorization: true,
          targetPayment: {
            network: "eip155:8453",
            asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
            payTo: "0x0000000000000000000000000000000000000001",
            amountAtomic: "1000",
            scheme: "exact",
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof globalThis.fetch;

  await assert.rejects(
    assertAgentResolverGuard({
      guardFetch,
      requestUrl: "https://merchant.example/mcp",
      method: "POST",
      paymentRequired: {
        x402Version: 2,
        resource: { url: "https://merchant.example/mcp" },
        accepts: [{
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x0000000000000000000000000000000000000001",
          amount: "1000",
        }],
      },
      requirement: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x0000000000000000000000000000000000000001",
        amount: "1000",
      },
      env: {},
    }),
    /did not confirm validation of the supplied 402 challenge/,
  );
});
