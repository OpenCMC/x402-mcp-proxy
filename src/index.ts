import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  createX402Fetch,
  errMsg,
  installPaymentGuards,
  loadPaymentLimits,
  type PaymentLimits,
  type SpendTracker,
} from "./payment.js";

// Config is read only from the proxy's own install dir (parent of src/ or dist/),
// never from the cwd the MCP host happens to launch us in.
const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
// quiet: dotenv otherwise logs to stdout, which is the MCP stdio channel
config({ path: resolve(PROJECT_ROOT, ".env"), quiet: true });

if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
  console.error("[x402-proxy] NODE_TLS_REJECT_UNAUTHORIZED=0 is not allowed, exiting.");
  process.exit(1);
}

let paymentLimits: PaymentLimits;
try {
  paymentLimits = loadPaymentLimits();
} catch (err) {
  console.error(`[x402-proxy] Invalid payment limits: ${errMsg(err)}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Remote MCP configuration
// ---------------------------------------------------------------------------
interface RemoteMcp {
  url: string;
  prefix: string;
  headers?: Record<string, string>;
  /** Set to false for remotes that never charge (e.g. API-key auth) so no payment is ever signed for them */
  x402?: boolean;
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
 *   { "x402mcpServers": [{ "url": "…", "prefix": "…", "headers": {}, "x402": true }] }
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

  // Relative paths resolve against the install dir; absolute paths are used as-is
  const configPath = resolve(PROJECT_ROOT, process.env.X402_CONFIG ?? "x402-mcps.json");
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
interface PaymentClient {
  httpClient: x402HTTPClient;
  tracker: SpendTracker;
}

async function createX402Client(): Promise<PaymentClient | null> {
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

  const tracker = installPaymentGuards(client, paymentLimits);
  return { httpClient: new x402HTTPClient(client), tracker };
}

// ---------------------------------------------------------------------------
// Connect to a remote MCP (Streamable HTTP → SSE fallback)
// ---------------------------------------------------------------------------
async function connectRemoteMcp(
  mcp: RemoteMcp,
  payment: PaymentClient | null,
): Promise<Client> {
  const url = new URL(mcp.url);
  const requestInit: RequestInit = { headers: mcp.headers ?? {} };
  // One payment fetch per remote, bound to that remote's origin
  const fetchFn =
    payment && mcp.x402 !== false
      ? createX402Fetch(payment.httpClient, url.origin, payment.tracker)
      : undefined;

  const streamable = new Client({ name: "x402-proxy", version: "1.0.0" });
  try {
    await streamable.connect(new StreamableHTTPClientTransport(url, { requestInit, fetch: fetchFn }));
    return streamable;
  } catch {
    // Close the failed client first so its standalone GET stream stops reconnecting
    await streamable.close().catch(() => {});
  }

  const client = new Client({ name: "x402-proxy", version: "1.0.0" });
  await client.connect(new SSEClientTransport(url, { requestInit, fetch: fetchFn }));
  return client;
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
  payment: PaymentClient | null,
): Promise<Map<string, ProxiedTool>> {
  const registry = new Map<string, ProxiedTool>();

  for (const mcp of x402MCPs) {
    try {
      const client = await connectRemoteMcp(mcp, payment);
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
      console.error(`[x402-proxy] ✗ ${mcp.prefix}: ${errMsg(err)}`);
    }
  }

  return registry;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const payment = await createX402Client();
  const registry = await discoverTools(payment);

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
  console.error(`[x402-proxy] Fatal: ${errMsg(error)}`);
  process.exit(1);
});
