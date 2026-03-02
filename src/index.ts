import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
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

config();

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

const x402MCPs: RemoteMcp[] = loadRemoteMcps();

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
// x402-aware fetch: intercepts HTTP 402, signs payment, retries
// ---------------------------------------------------------------------------
function createX402Fetch(
  httpClient: x402HTTPClient,
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);

    if (response.status !== 402) return response;

    console.error("[x402-proxy] 402 received, handling payment…");

    const paymentRequired = httpClient.getPaymentRequiredResponse(
      (name) => response.headers.get(name) ?? null,
    );

    const hookHeaders = await httpClient.handlePaymentRequired(paymentRequired);
    if (hookHeaders) {
      const merged = mergeHeaders(init?.headers, hookHeaders);
      return baseFetch(input, { ...init, headers: merged });
    }

    const payload = await httpClient.createPaymentPayload(paymentRequired);
    const paymentHeaders = httpClient.encodePaymentSignatureHeader(payload);

    console.error("[x402-proxy] Payment signed, retrying request…");

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

  const server = new Server(
    { name: "x402 MCP Proxy", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Array.from(registry.values()).map((r) => r.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
  await server.connect(transport);
  console.error(
    `[x402-proxy] Ready — ${registry.size} tools from ${x402MCPs.length} remote MCP(s)`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
