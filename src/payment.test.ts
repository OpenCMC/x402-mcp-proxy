import { test } from "node:test";
import assert from "node:assert/strict";
import {
  x402Client,
  x402HTTPClient,
  type PaymentRequirements,
  type SchemeNetworkClient,
} from "@x402/axios";
import {
  createX402Fetch,
  installPaymentGuards,
  isToolsCall,
  loadPaymentLimits,
  rejectReason,
  type PaymentLimits,
} from "./payment.js";

const ORIGIN = "https://remote.example.com";
const URL_ = `${ORIGIN}/mcp`;
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const limits: PaymentLimits = loadPaymentLimits({
  X402_MAX_PAYMENT: "100000",
  X402_MAX_SPEND_PER_SESSION: "250000",
});

function req(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "eip155:8453",
    asset: BASE_USDC,
    amount: "100000",
    payTo: "0x000000000000000000000000000000000000dEaD",
    maxTimeoutSeconds: 60,
    extra: {},
    ...overrides,
  };
}

function paymentRequiredHeader(accepts: unknown[]): string {
  return Buffer.from(
    JSON.stringify({ x402Version: 2, resource: { url: URL_ }, accepts }),
  ).toString("base64");
}

/** Fake scheme that records what it was asked to sign, so no key or network is needed */
function setup() {
  const signed: PaymentRequirements[] = [];
  const scheme: SchemeNetworkClient = {
    scheme: "exact",
    async createPaymentPayload(x402Version, requirements) {
      signed.push(requirements);
      return { x402Version, payload: { sig: "fake" } };
    },
  };
  const client = new x402Client().register("eip155:*", scheme);
  const tracker = installPaymentGuards(client, limits);
  return { signed, tracker, httpClient: new x402HTTPClient(client) };
}

/** Base fetch that answers 402 until a payment signature is presented */
function fake402(accepts: unknown[], opts: { url?: string } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const headers = new Headers(init?.headers as Record<string, string>);
    if (headers.has("PAYMENT-SIGNATURE")) return new Response("ok", { status: 200 });
    const res = new Response(null, {
      status: 402,
      headers: { "PAYMENT-REQUIRED": paymentRequiredHeader(accepts) },
    });
    if (opts.url) Object.defineProperty(res, "url", { value: opts.url });
    return res;
  };
  return { calls, fetchFn };
}

const toolsCall = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x" } });
const post = (body = toolsCall): RequestInit => ({ method: "POST", body });

test("loadPaymentLimits rejects malformed or empty values", () => {
  assert.throws(() => loadPaymentLimits({ X402_MAX_PAYMENT: "0x10" }));
  assert.throws(() => loadPaymentLimits({ X402_MAX_PAYMENT: "1e9" }));
  assert.throws(() => loadPaymentLimits({ X402_ALLOWED_ASSETS: "" }));
  assert.throws(() => loadPaymentLimits({ X402_ALLOWED_NETWORKS: " , " }));
});

test("rejectReason checks the v2 amount field strictly", () => {
  assert.equal(rejectReason(req(), limits), null);
  assert.match(rejectReason(req({ amount: "100001" }), limits)!, /exceeds/);
  assert.match(rejectReason(req({ amount: "0x1" }), limits)!, /decimal/);
  assert.match(rejectReason(req({ amount: 5 as never }), limits)!, /decimal/);
  // v1-style field only: amount missing must not be treated as 0
  const v1 = { ...req(), amount: undefined, maxAmountRequired: "1" } as never;
  assert.match(rejectReason(v1, limits)!, /decimal/);
  assert.match(rejectReason(req({ network: "eip155:1" }), limits)!, /network/);
  assert.match(rejectReason(req({ asset: "0x" + "1".repeat(40) }), limits)!, /asset/);
  assert.equal(rejectReason(req({ asset: BASE_USDC.toLowerCase() }), limits), null);
});

test("isToolsCall only accepts a single tools/call message", () => {
  assert.equal(isToolsCall(toolsCall), true);
  assert.equal(isToolsCall(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })), false);
  assert.equal(isToolsCall(`[${toolsCall}]`), false);
  assert.equal(isToolsCall("not json"), false);
  assert.equal(isToolsCall(undefined), false);
});

test("pays a valid tools/call 402 and signs exactly the validated amount", async () => {
  const { signed, tracker, httpClient } = setup();
  const { calls, fetchFn } = fake402([req({ amount: "50000" })]);
  const res = await createX402Fetch(httpClient, ORIGIN, tracker, fetchFn)(URL_, post());
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(signed.length, 1);
  assert.equal(signed[0].amount, "50000");
  assert.equal(tracker.spent(), BigInt(50000));
});

test("never signs an amount over the per-request limit", async () => {
  const { signed, tracker, httpClient } = setup();
  const { fetchFn } = fake402([req({ amount: "999999999" })]);
  const res = await createX402Fetch(httpClient, ORIGIN, tracker, fetchFn)(URL_, post());
  assert.equal(res.status, 402);
  assert.equal(signed.length, 0);
  assert.equal(tracker.spent(), BigInt(0));
});

test("picks the in-limit option when the remote offers several", async () => {
  const { signed, tracker, httpClient } = setup();
  const { fetchFn } = fake402([req({ amount: "999999999" }), req({ amount: "1000" })]);
  const res = await createX402Fetch(httpClient, ORIGIN, tracker, fetchFn)(URL_, post());
  assert.equal(res.status, 200);
  assert.deepEqual(signed.map((r) => r.amount), ["1000"]);
});

test("enforces the session limit, including for concurrent calls", async () => {
  const { signed, tracker, httpClient } = setup();
  const { fetchFn } = fake402([req({ amount: "100000" })]);
  const pay = createX402Fetch(httpClient, ORIGIN, tracker, fetchFn);
  const results = await Promise.all([1, 2, 3, 4].map(() => pay(URL_, post())));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 402, 402]);
  assert.equal(signed.length, 2);
  assert.equal(tracker.spent(), BigInt(200000));
});

test("releases the reservation when signing fails", async () => {
  const client = new x402Client().register("eip155:*", {
    scheme: "exact",
    async createPaymentPayload() {
      throw new Error("signer down");
    },
  });
  const tracker = installPaymentGuards(client, limits);
  const { fetchFn } = fake402([req()]);
  const res = await createX402Fetch(new x402HTTPClient(client), ORIGIN, tracker, fetchFn)(URL_, post());
  assert.equal(res.status, 402);
  assert.equal(tracker.spent(), BigInt(0));
});

test("does not pay for non-tools/call traffic", async () => {
  const { signed, tracker, httpClient } = setup();
  const { fetchFn } = fake402([req()]);
  const pay = createX402Fetch(httpClient, ORIGIN, tracker, fetchFn);
  const listBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal((await pay(URL_, { method: "GET" })).status, 402);
  assert.equal((await pay(URL_)).status, 402);
  assert.equal((await pay(URL_, post(listBody))).status, 402);
  assert.equal((await pay(URL_, post(`[${toolsCall}]`))).status, 402);
  assert.equal(signed.length, 0);
});

test("does not pay a different origin or a redirected response", async () => {
  const { signed, tracker, httpClient } = setup();
  const pay = createX402Fetch(httpClient, ORIGIN, tracker, fake402([req()]).fetchFn);
  assert.equal((await pay("https://evil.example.com/mcp", post())).status, 402);

  const redirected = fake402([req()], { url: "https://evil.example.com/mcp" });
  const payRedirected = createX402Fetch(httpClient, ORIGIN, tracker, redirected.fetchFn);
  assert.equal((await payRedirected(URL_, post())).status, 402);
  assert.equal(signed.length, 0);
});

test("returns the raw 402 for a malformed PAYMENT-REQUIRED header", async () => {
  const { signed, tracker, httpClient } = setup();
  const fetchFn: typeof fetch = async () =>
    new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": "%%%" } });
  const res = await createX402Fetch(httpClient, ORIGIN, tracker, fetchFn)(URL_, post());
  assert.equal(res.status, 402);
  assert.equal(signed.length, 0);
});
