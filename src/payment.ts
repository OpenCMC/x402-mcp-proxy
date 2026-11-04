import type { PaymentRequirements, x402Client, x402HTTPClient } from "@x402/axios";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Log-safe output: JSON-escape control characters and truncate, so remote fields can't forge log lines */
export function logSafe(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v ?? null) ?? "null";
  } catch {
    s = '"<unserializable>"';
  }
  return s
    .replace(/[\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .slice(0, 256);
}

// ---------------------------------------------------------------------------
// Payment safety limits
// ---------------------------------------------------------------------------
export interface PaymentLimits {
  maxPerRequest: bigint;
  maxPerSession: bigint;
  allowedNetworks: Set<string>;
  allowedAssets: Set<string>;
}

/** Atomic amounts must be plain unsigned decimal integers (BigInt() alone would also accept "0x…", " 1", etc.) */
const ATOMIC_AMOUNT_RE = /^(0|[1-9][0-9]*)$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const DEFAULT_NETWORKS = "eip155:8453,solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const DEFAULT_ASSETS =
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function parseAmountEnv(name: string, value: string): bigint {
  if (!ATOMIC_AMOUNT_RE.test(value)) {
    throw new Error(`${name} must be an unsigned decimal integer, got ${logSafe(value)}`);
  }
  return BigInt(value);
}

function parseListEnv(name: string, value: string): Set<string> {
  const list = new Set(value.split(",").map((s) => s.trim()).filter(Boolean));
  if (list.size === 0) {
    throw new Error(`${name} must not be empty`);
  }
  return list;
}

/** Throws on malformed values — an empty allowlist means "allow nothing", never "allow everything". */
export function loadPaymentLimits(env: NodeJS.ProcessEnv = process.env): PaymentLimits {
  return {
    maxPerRequest: parseAmountEnv("X402_MAX_PAYMENT", env.X402_MAX_PAYMENT ?? "100000"),
    maxPerSession: parseAmountEnv("X402_MAX_SPEND_PER_SESSION", env.X402_MAX_SPEND_PER_SESSION ?? "1000000"),
    allowedNetworks: parseListEnv("X402_ALLOWED_NETWORKS", env.X402_ALLOWED_NETWORKS ?? DEFAULT_NETWORKS),
    allowedAssets: parseListEnv("X402_ALLOWED_ASSETS", env.X402_ALLOWED_ASSETS ?? DEFAULT_ASSETS),
  };
}

function assetAllowed(asset: string, limits: PaymentLimits): boolean {
  if (limits.allowedAssets.has(asset)) return true;
  // EVM addresses are case-insensitive; everything else (e.g. Solana base58) must match exactly
  if (EVM_ADDRESS_RE.test(asset)) {
    const lower = asset.toLowerCase();
    for (const a of limits.allowedAssets) {
      if (EVM_ADDRESS_RE.test(a) && a.toLowerCase() === lower) return true;
    }
  }
  return false;
}

/** Returns why a single payment option is unacceptable, or null if it is within limits. */
export function rejectReason(req: PaymentRequirements, limits: PaymentLimits): string | null {
  if (!req || typeof req !== "object") return "malformed requirement";
  if (typeof req.network !== "string" || !limits.allowedNetworks.has(req.network)) {
    return `network ${logSafe(req.network)} is not in the allowed list`;
  }
  if (typeof req.asset !== "string" || !assetAllowed(req.asset, limits)) {
    return `asset ${logSafe(req.asset)} is not in the allowed list`;
  }
  if (typeof req.amount !== "string" || !ATOMIC_AMOUNT_RE.test(req.amount)) {
    return `amount ${logSafe(req.amount)} is not an unsigned decimal integer`;
  }
  if (BigInt(req.amount) > limits.maxPerRequest) {
    return `amount ${req.amount} exceeds per-request limit ${limits.maxPerRequest}`;
  }
  return null;
}

export interface SpendTracker {
  /** Total amount reserved for signed (or in-flight) payments this session */
  spent(): bigint;
}

/**
 * Hooks the limits into x402Client's own selection flow, so the requirement that gets
 * validated is exactly the one the scheme signs:
 *   - policy: drop options outside the limits before the selector picks one
 *   - onBeforePaymentCreation: re-check the selected option and reserve session budget
 *     (check + reserve happen synchronously, so concurrent tool calls can't both pass)
 *   - onPaymentCreationFailure: release the reservation if signing failed
 */
export function installPaymentGuards(client: x402Client, limits: PaymentLimits): SpendTracker {
  let sessionSpend = BigInt(0);

  client.registerPolicy((_version, reqs) => reqs.filter((r) => rejectReason(r, limits) === null));

  client.onBeforePaymentCreation(async ({ selectedRequirements: req }) => {
    const reason = rejectReason(req, limits);
    if (reason) return { abort: true, reason };

    const amount = BigInt(req.amount);
    if (sessionSpend + amount > limits.maxPerSession) {
      return {
        abort: true,
        reason:
          `session spending limit reached ` +
          `(spent: ${sessionSpend}, request: ${amount}, limit: ${limits.maxPerSession})`,
      };
    }
    sessionSpend += amount;
  });

  client.onPaymentCreationFailure(async ({ selectedRequirements: req }) => {
    sessionSpend -= BigInt(req.amount);
  });

  return { spent: () => sessionSpend };
}

// ---------------------------------------------------------------------------
// x402-aware fetch: only pays for JSON-RPC tools/call POSTs to the bound origin
// ---------------------------------------------------------------------------
function requestUrlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** True only for a single (non-batch) JSON-RPC tools/call request body */
export function isToolsCall(body: BodyInit | null | undefined): boolean {
  if (typeof body !== "string") return false;
  try {
    const msg = JSON.parse(body);
    return !!msg && !Array.isArray(msg) && msg.jsonrpc === "2.0" && msg.method === "tools/call";
  } catch {
    return false;
  }
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function blockReason(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  response: Response,
  origin: string,
): string | null {
  if (typeof input !== "string" && !(input instanceof URL)) return "unsupported request object";
  if ((init?.method ?? "GET").toUpperCase() !== "POST") return "not a POST request";
  if (!isToolsCall(init?.body)) return "not a tools/call request";
  if (!sameOrigin(requestUrlOf(input), origin)) return "request origin does not match the configured remote";
  // A redirect may have taken us elsewhere; only pay the origin we were configured for
  if (response.url && !sameOrigin(response.url, origin)) return "response origin does not match the configured remote";
  return null;
}

export function createX402Fetch(
  httpClient: x402HTTPClient,
  origin: string,
  tracker: SpendTracker,
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);

    if (response.status !== 402) return response;

    const requestUrl = requestUrlOf(input);
    const blocked = blockReason(input, init, response, origin);
    if (blocked) {
      console.error(`[x402-proxy] 402 not paid for ${logSafe(requestUrl)}: ${blocked}`);
      return response;
    }

    console.error(`[x402-proxy] 402 received for ${logSafe(requestUrl)}`);

    let paymentHeaders: Record<string, string>;
    let accepted: PaymentRequirements;
    try {
      const paymentRequired = httpClient.getPaymentRequiredResponse(
        (name) => response.headers.get(name) ?? null,
      );
      const payload = await httpClient.createPaymentPayload(paymentRequired);
      paymentHeaders = httpClient.encodePaymentSignatureHeader(payload);
      accepted = payload.accepted;
    } catch (err) {
      console.error(`[x402-proxy] Payment rejected: ${logSafe(errMsg(err))}`);
      return response;
    }

    console.error(
      `[x402-proxy] Payment: ${accepted.amount} | ` +
        `network: ${logSafe(accepted.network)} | asset: ${logSafe(accepted.asset)} | ` +
        `payTo: ${logSafe(accepted.payTo)} | url: ${logSafe(requestUrl)} | ` +
        `session total: ${tracker.spent()}`,
    );

    const merged = mergeHeaders(init?.headers, paymentHeaders);
    return baseFetch(input, { ...init, headers: merged });
  };
}

function mergeHeaders(
  existing: HeadersInit | undefined,
  extra: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};

  if (existing instanceof Headers) {
    existing.forEach((v, k) => { result[k] = v; });
  } else if (Array.isArray(existing)) {
    for (const [k, v] of existing) result[k] = v;
  } else if (existing) {
    Object.assign(result, existing);
  }

  Object.assign(result, extra);
  return result;
}
