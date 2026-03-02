# x402 MCP Proxy

A local MCP (Model Context Protocol) proxy that connects to remote MCP servers and **automatically handles [x402](https://docs.cdp.coinbase.com/x402/welcome) payments**. When a remote MCP tool triggers an HTTP 402 response, the proxy signs a USDC payment on-chain and retries — transparently, with no changes needed on the client side.

## How It Works

```
┌─────────────┐      stdio       ┌──────────────┐    HTTP + x402     ┌──────────────┐
│  AI Client   │ ◄──────────────► │  x402 Proxy  │ ◄────────────────► │ Remote MCP A │
│ (Claude, etc)│                  │  (this repo)  │                   ├──────────────┤
└─────────────┘                  │              │ ◄────────────────► │ Remote MCP B │
                                  └──────────────┘                   └──────────────┘
```

1. The proxy connects to one or more remote MCP servers (via Streamable HTTP or SSE).
2. It discovers their tools and re-exposes them to the AI client over stdio, prefixed by server name (e.g. `cmc_get_quotes`).
3. When a tool call returns HTTP 402, the proxy intercepts it, signs an EIP-3009 `transferWithAuthorization` (USDC on Base), and retries automatically.

## Quick Start

### 1. Install

```bash
git clone https://github.com/user/x402-mcp-proxy.git
cd x402-mcp-proxy
pnpm install
```

### 2. Configure Remote MCPs

Create `x402-mcps.json` in the project root (see `x402-mcps.example.json`):

```json
{
  "x402mcpServers": [
    {
      "url": "https://pro.coinmarketcap.com/x402/mcp",
      "prefix": "cmc"
    },
    {
      "url": "https://other-mcp.example.com/mcp",
      "prefix": "other",
      "headers": {
        "Authorization": "Bearer your_token"
      }
    }
  ]
}
```

Or pass it as an environment variable (prefix, url pairs):

```bash
export X402_REMOTE_MCPS="cmc,https://pro.coinmarketcap.com/x402/mcp"
```

### 3. Configure Wallet

Copy `.env.example` to `.env` and add at least one private key:

```bash
cp .env.example .env
```

```env
EVM_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
```

The EVM wallet needs USDC on Base for x402 payments. Solana (SVM) is also supported.

### 4. Run

```bash
pnpm dev    # development (tsx)
pnpm build && pnpm start  # production
```

### 5. Connect from an AI Client

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "x402": {
      "command": "npx",
      "args": ["tsx", "/path/to/x402-mcp-proxy/src/index.ts"],
      "env": {
        "EVM_PRIVATE_KEY": "0x...",
        "X402_REMOTE_MCPS": ["cmc", "https://pro.coinmarketcap.com/x402/mcp"]
      }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "x402": {
      "command": "npx",
      "args": ["tsx", "/path/to/x402-mcp-proxy/src/index.ts"],
      "env": {
        "EVM_PRIVATE_KEY": "0x...",
        "X402_REMOTE_MCPS": ["cmc", "https://pro.coinmarketcap.com/x402/mcp"]
      }
    }
  }
}
```

You can also point to a config file for more advanced options (custom headers, etc.):

```json
"X402_CONFIG": "/path/to/x402-mcps.json"
```

## Configuration Reference

### Remote MCP Servers

| Source | Description |
|--------|------------|
| `X402_REMOTE_MCPS` env | Flat pair list: `["prefix","url",…]` or `"prefix,url,…"` (takes priority) |
| `X402_CONFIG` env | Custom path to a JSON config file |
| `x402-mcps.json` | Default config file in project root |

**Env var format** — prefix/url pairs, no headers support:

```json
["cmc", "https://pro.coinmarketcap.com/x402/mcp"]
```

**Config file format** — full control with headers:

```json
{
  "x402mcpServers": [
    {
      "prefix": "cmc",
      "url": "https://pro.coinmarketcap.com/x402/mcp"
    },
    {
      "prefix": "other",
      "url": "https://other.example.com/mcp",
      "headers": { "Authorization": "Bearer xxx" }
    }
  ]
}
```

### Wallet Keys

| Env Variable | Description |
|-------------|-------------|
| `EVM_PRIVATE_KEY` | EVM private key (0x-prefixed hex). Used for USDC payments on Base. |
| `SVM_PRIVATE_KEY` | Solana private key (base58-encoded). Used for USDC payments on Solana. |

At least one key is required for x402 payment handling.

## What is x402?

[x402](https://docs.cdp.coinbase.com/x402/welcome) is an open protocol by Coinbase that enables instant, pay-per-request API access using stablecoin payments over HTTP. When an API returns HTTP 402, the client signs a USDC transfer authorization, and the server's facilitator executes the on-chain payment only after successfully delivering the response.

Key properties:
- **No subscription needed** — pay per request with USDC
- **Pay only on success** — if the server fails to return data, the signed authorization expires unused and no payment is deducted
- **Works on Base** (EVM) and **Solana**

## Project Structure

```
x402-mcp-proxy/
├── src/index.ts           # Proxy entry point
├── x402-mcps.example.json # Example remote MCP config
├── .env.example           # Example environment variables
├── package.json
├── tsconfig.json
└── LICENSE                # MIT
```

## License

[MIT](LICENSE)
