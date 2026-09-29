import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { x402Client, x402HTTPClient } from "@x402/axios";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";
import { config } from "dotenv";
import {
  agentResolverGuardEnabled,
  assertAgentResolverGuard,
  bindGuardedRequirement,
  selectGuardRequirement,
} from "./agentresolver.js";

config();

// ---------------------------------------------------------------------------
// Payment safety limits
// ---------------------------------------------------------------------------
interface PaymentLimits {
  maxPerRequest: bigint;
  maxPerSession: bigint;
  allowedNetworks: Set<string>;
  allowedAssets: Set<string>;
}

function loadPaymentLimits(): PaymentLimits {
  return {
    maxPerRequest: BigInt(process.env.X402_MAX_PAYMENT ?? "100000"),
    maxPerSession: BigInt(process.env.X402_MAX_SPEND_PER_SESSION ?? "1000000"),
    allowedNetworks: new Set(
      (process.env.X402_ALLOWED_NETWORKS ?? "eip155:8453,solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")
        .split(",").map((s) => s.trim()).filter(Boolean),
    ),
    allowedAssets: new Set(
      (
        process.env.X402_ALLOWED_ASSETS ??
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
      )
        .split(",").map((s) => s.trim()).filter(Boolean),
    ),
  };
}

const paymentLimits = loadPaymentLimits();
let sessionSpend = BigInt(0);

// ---------------------------------------------------------------------------
// Remote MCP configuration
// ---------------------------------------------------------------------------
interface RemoteMcp {
  url: string;
  prefix: string;
  headers?: Record<string, string>;
}

/**
 * Load remote MCP server list. Resolution order:
 *   1. X402_REMOTE_MCPS env var — flat pair list: "prefix1,url1,prefix2,url2,…"
 *   2. Config file at X402_CONFIG env var path, or default x402-mcps.json
 *
 * Env var format (comma-separated or JSON string array):
 *   "example,https://mcp.example.com/mcp,other,https://other.com/mcp"
 *   or ["example","https://mcp.example.com/mcp","other","https://other.com/mcp"]
 *
 * Config file format ({ "x402mcpServers": [...] } or bare array):
 *   { "x402mcpServers": [{ "url": "…", "prefix": "…", "headers": {} }] }
 */
function loadRemoteMcps(): RemoteMcp[] {
  const envMcps = process.env.X402_REMOTE_MCPS;
  if (envMcps) {
    const list = parseEnvMcps(envMcps);
    if (list.length) {
      console.error(`[x402-proxy] Loaded ${list.length} remote MCP(s) from X402_REMOTE_MCPS env`);
      return list;
    }
  }

  const configPath = resolve(process.env.X402_CONFIG ?? "x402-mcps.json");
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    const list = extractList(parsed);
    console.error(`[x402-proxy] Loaded ${list.length} remote MCP(s) from ${configPath}`);
    return list;
  } catch {
    // config file not found or invalid — acceptable
  }

  return [];
}

/**
 * Parse X402_REMOTE_MCPS env var. Accepts:
 *   - Flat string pairs: "prefix1,url1,prefix2,url2"
 *   - JSON string array:  ["prefix1","url1","prefix2","url2"]
 *   - JSON object array:  [{"url":"…","prefix":"…"}]
 */
function parseEnvMcps(raw: string): RemoteMcp[] {
  const trimmed = raw.trim();

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed) || parsed.length === 0) return [];
      if (typeof parsed[0] === "object" && parsed[0].url) return parsed;
      return pairsToMcps(parsed);
    } catch {
      console.error("[x402-proxy] Failed to parse X402_REMOTE_MCPS JSON");
      return [];
    }
  }

  return pairsToMcps(trimmed.split(",").map(s => s.trim()).filter(Boolean));
}

function pairsToMcps(pairs: string[]): RemoteMcp[] {
  const result: RemoteMcp[] = [];
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    result.push({ prefix: pairs[i], url: pairs[i + 1] });
  }
  return result;
}

function extractList(parsed: unknown): RemoteMcp[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.x402mcpServers)) return obj.x402mcpServers;
  }
  return [];
}

function warnInsecureUrls(mcps: RemoteMcp[]): void {
  for (const mcp of mcps) {
    try {
      const parsed = new URL(mcp.url);
      const isLocal = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
      if (parsed.protocol !== "https:" && !isLocal) {
        console.error(
          `[x402-proxy] WARNING: "${mcp.prefix}" uses insecure protocol ` +
            `(${parsed.protocol}). Payment signatures may be exposed in transit.`,
        );
      }
    } catch {
      console.error(
        `[x402-proxy] WARNING: "${mcp.prefix}" has an invalid URL: ${mcp.url}`,
      );
    }
  }
}

const x402MCPs: RemoteMcp[] = loadRemoteMcps();
warnInsecureUrls(x402MCPs);

if (x402MCPs.length === 0) {
  console.error(
    "[x402-proxy] No remote MCPs configured.\n" +
    "  Set X402_REMOTE_MCPS env var (JSON array) or create x402-mcps.json.\n" +
    "  See README.md for details.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// x402 payment client
// ---------------------------------------------------------------------------
async function createX402Client(): Promise<x402HTTPClient | null> {
  const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
  const svmPrivateKey = process.env.SVM_PRIVATE_KEY as string | undefined;

  if (!evmPrivateKey && !svmPrivateKey) {
    console.error("No private key found, exiting.");
    return null;
  }

  const client = new x402Client();

  if (evmPrivateKey) {
    const account = privateKeyToAccount(evmPrivateKey);
    const publicClient = createPublicClient({
      chain: base,
      transport: http(),
    });
    client.register("eip155:*", new ExactEvmScheme(toClientEvmSigner(account, publicClient)));
  }

  if (svmPrivateKey) {
    const svmSigner = await createKeyPairSignerFromBytes(
      base58.decode(svmPrivateKey),
    );
    client.register("solana:*", new ExactSvmScheme(svmSigner));
  }

  return new x402HTTPClient(client);
}

// ---------------------------------------------------------------------------
// Payment validation & audit
// ---------------------------------------------------------------------------
interface PaymentAccept {
  maxAmountRequired?: string;
  amount?: string;
  scheme?: string;
  network?: string;
  asset?: string;
  payTo?: string;
}

function assetAllowed(asset: string): boolean {
  if (paymentLimits.allowedAssets.size === 0) return true;
  if (paymentLimits.allowedAssets.has(asset)) return true;
  if (asset.startsWith("0x")) {
    const lower = asset.toLowerCase();
    for (const a of paymentLimits.allowedAssets) {
      if (a.startsWith("0x") && a.toLowerCase() === lower) return true;
    }
  }
  return false;
}

function validatePaymentRequired(
  accepts: PaymentAccept[] | undefined,
  requestUrl: string,
): bigint {
  if (!Array.isArray(accepts) || accepts.length === 0) {
    throw new Error(`Malformed 402 for ${requestUrl}: no payment schemes`);
  }

  let maxCost = BigInt(0);
  for (const s of accepts) {
    const amount = BigInt(s.amount ?? s.maxAmountRequired ?? "0");
    const network = s.network ?? "";
    const asset = s.asset ?? "";

    if (amount > paymentLimits.maxPerRequest) {
      throw new Error(
        `Amount ${amount} exceeds per-request limit ${paymentLimits.maxPerRequest} ` +
          `(network: ${network}, payTo: ${s.payTo ?? "?"})`,
      );
    }

    if (
      paymentLimits.allowedNetworks.size > 0 &&
      !paymentLimits.allowedNetworks.has(network)
    ) {
      throw new Error(`Network "${network}" is not in the allowed list`);
    }

    if (asset && !assetAllowed(asset)) {
      throw new Error(`Asset "${asset}" is not in the allowed list`);
    }

    if (amount > maxCost) maxCost = amount;
  }

  if (sessionSpend + maxCost > paymentLimits.maxPerSession) {
    throw new Error(
      `Session spending limit reached ` +
        `(spent: ${sessionSpend}, request: ${maxCost}, limit: ${paymentLimits.maxPerSession})`,
    );
  }

  return maxCost;
}

function logPaymentAudit(
  accepts: PaymentAccept[] | undefined,
  requestUrl: string,
  cost: bigint,
): void {
  const s = accepts?.[0];
  console.error(
    `[x402-proxy] Payment: ${cost} | ` +
      `network: ${s?.network ?? "?"} | asset: ${s?.asset ?? "?"} | ` +
      `payTo: ${s?.payTo ?? "?"} | url: ${requestUrl} | ` +
      `session total: ${sessionSpend}`,
  );
}

// ---------------------------------------------------------------------------
// x402-aware fetch: intercepts HTTP 402, validates, signs payment, retries
// ---------------------------------------------------------------------------
function createX402Fetch(
  httpClient: x402HTTPClient,
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
  guardEnabled = true,
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);

    if (response.status !== 402) return response;

    const requestUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    console.error(`[x402-proxy] 402 received for ${requestUrl}`);

    const paymentRequired = httpClient.getPaymentRequiredResponse(
      (name) => response.headers.get(name) ?? null,
    );

    const accepts = paymentRequired.accepts;

    let estimatedCost: bigint;
    let paymentRequiredForSigning = paymentRequired;
    let acceptsForSigning = accepts;
    try {
      estimatedCost = validatePaymentRequired(accepts, requestUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[x402-proxy] Payment rejected: ${msg}`);
      return response;
    }

    const hookHeaders =
      await httpClient.handlePaymentRequired(paymentRequired);
    if (hookHeaders) {
      sessionSpend += estimatedCost;
      logPaymentAudit(acceptsForSigning, requestUrl, estimatedCost);
      const merged = mergeHeaders(init?.headers, hookHeaders);
      return baseFetch(input, { ...init, headers: merged });
    }

    if (guardEnabled && agentResolverGuardEnabled()) {
      const selectedRequirement = selectGuardRequirement(accepts, {
        evm: Boolean(process.env.EVM_PRIVATE_KEY),
        svm: Boolean(process.env.SVM_PRIVATE_KEY),
      });

      if (!selectedRequirement) {
        console.error(
          "[x402-proxy] AgentResolver Guard failed closed: no supported exact payment requirement for " +
            requestUrl,
        );
        return response;
      }

      const requestMethod = (
        init?.method ??
        (input instanceof Request ? input.method : "GET")
      ).toUpperCase();

      try {
        // Separate hook-free path for AgentResolver's own $0.001 x402 fee.
        const guardFetch = createX402Fetch(httpClient, baseFetch, false);
        await assertAgentResolverGuard({
          guardFetch,
          requestUrl,
          method: requestMethod,
          paymentRequired,
          requirement: selectedRequirement,
        });

        // The Guard fee counts toward session spend. Re-check the merchant
        // payment against the updated total before any target signature exists.
        paymentRequiredForSigning = bindGuardedRequirement(
          paymentRequired,
          selectedRequirement,
        );
        acceptsForSigning = [selectedRequirement];
        estimatedCost = validatePaymentRequired(acceptsForSigning, requestUrl);
        console.error(
          "[x402-proxy] AgentResolver Guard eligible: " + requestUrl,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[x402-proxy] AgentResolver Guard blocked: " + msg);
        return response;
      }
    }


    const payload =
      await httpClient.createPaymentPayload(paymentRequiredForSigning);
    const paymentHeaders =
      httpClient.encodePaymentSignatureHeader(payload);

    sessionSpend += estimatedCost;
    logPaymentAudit(acceptsForSigning, requestUrl, estimatedCost);

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

// ---------------------------------------------------------------------------
// Connect to a remote MCP (Streamable HTTP → SSE fallback)
// ---------------------------------------------------------------------------
async function connectRemoteMcp(
  mcp: RemoteMcp,
  x402Fetch: typeof globalThis.fetch | null,
): Promise<Client> {
  const url = new URL(mcp.url);
  const requestInit: RequestInit = { headers: mcp.headers ?? {} };
  const fetchFn = x402Fetch ?? undefined;

  try {
    const client = new Client({ name: "x402-proxy", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit,
      fetch: fetchFn,
    });
    await client.connect(transport);
    return client;
  } catch {
    const client = new Client({ name: "x402-proxy", version: "1.0.0" });
    const transport = new SSEClientTransport(url, {
      requestInit,
      eventSourceInit: { fetch: fetchFn as never },
    });
    await client.connect(transport);
    return client;
  }
}

// ---------------------------------------------------------------------------
// Discover & register tools
// ---------------------------------------------------------------------------
interface ProxiedTool {
  tool: Tool;
  client: Client;
  originalName: string;
}

async function discoverTools(
  x402Fetch: typeof globalThis.fetch | null,
): Promise<Map<string, ProxiedTool>> {
  const registry = new Map<string, ProxiedTool>();

  for (const mcp of x402MCPs) {
    try {
      const client = await connectRemoteMcp(mcp, x402Fetch);
      const { tools } = await client.listTools();

      for (const tool of tools) {
        const prefixedName = `${mcp.prefix}_${tool.name}`;
        registry.set(prefixedName, {
          tool: {
            ...tool,
            name: prefixedName,
            description: tool.description
              ? `[${mcp.prefix}] ${tool.description}`
              : `[${mcp.prefix}] ${tool.name}`,
          },
          client,
          originalName: tool.name,
        });
      }

      console.error(
        `[x402-proxy] ✓ ${mcp.prefix}: ${tools.length} tools from ${mcp.url}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[x402-proxy] ✗ ${mcp.prefix}: ${msg}`);
    }
  }

  return registry;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const httpClient = await createX402Client();
  const x402Fetch = httpClient ? createX402Fetch(httpClient) : null;
  const registry = await discoverTools(x402Fetch);

  if (registry.size === 0) {
    console.error("[x402-proxy] No tools discovered, exiting.");
    process.exit(1);
  }

  const mcpServer = new McpServer(
    { name: "x402 MCP Proxy", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  mcpServer.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Array.from(registry.values()).map((r) => r.tool),
  }));

  mcpServer.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const entry = registry.get(name);

    if (!entry) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    return await entry.client.callTool({
      name: entry.originalName,
      arguments: args,
    });
  });

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error(
    `[x402-proxy] Ready — ${registry.size} tools from ${x402MCPs.length} remote MCP(s)`,
  );
}

main().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`[x402-proxy] Fatal: ${msg}`);
  process.exit(1);
});
