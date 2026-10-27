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
git clone https://github.com/coinmarketcap-official/x402-mcp-proxy.git
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

The EVM wallet needs USDC on Base for x402 payments. Solana (SVM) and [Casper](#casper-network-optional) are also supported.

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
| `CASPER_PRIVATE_KEY` | Casper secret key as hex: `01` + 64 hex chars (Ed25519) or `02` + 64 hex chars (secp256k1). Used for CEP-18 token payments on Casper. Optional. |

At least one key is required for x402 payment handling.

### Payment Safety Limits

The proxy validates every 402 payment request before signing. All limits are configurable via environment variables:

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `X402_MAX_PAYMENT` | `100000` (0.10 USDC) | Maximum amount per single request (in asset smallest unit) |
| `X402_MAX_SPEND_PER_SESSION` | `1000000` (1.00 USDC) | Maximum cumulative spend per proxy session |
| `X402_ALLOWED_NETWORKS` | `eip155:8453,solana:5eykt…` | Comma-separated allowlist of CAIP-2 network IDs |
| `X402_ALLOWED_ASSETS` | Base USDC, Solana USDC | Comma-separated allowlist of asset contract addresses |

If a 402 response requests an amount, network, or asset outside these limits, the proxy **rejects the payment and returns the raw 402 to the client** without signing anything. Session spend resets when the proxy process restarts.

### Casper Network (optional)

The proxy can also pay x402 challenges on [Casper](https://casper.network) using the `exact` scheme from [`@make-software/casper-x402`](https://github.com/make-software/casper-x402) (registered for `casper:*`). Payments are EIP-712 signed `transfer_with_authorization` messages for a CEP-18 token (e.g. wCSPR), settled on-chain by the Casper facilitator.

The Casper rail is **off by default**. It is only enabled when `CASPER_PRIVATE_KEY` is set, and Casper payments are only signed once you add the network and token to the allowlists:

```env
CASPER_PRIVATE_KEY=01<64_hex_chars>
X402_ALLOWED_NETWORKS=eip155:8453,solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp,casper:casper
X402_ALLOWED_ASSETS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v,<cep18_contract_package_hash>
```

| Network | CAIP-2 ID | Explorer |
|---------|-----------|----------|
| Casper Mainnet | `casper:casper` | [cspr.live](https://cspr.live) |
| Casper Testnet | `casper:casper-test` | [testnet.cspr.live](https://testnet.cspr.live) |

- **Key format** — `CASPER_PRIVATE_KEY` is the 32-byte secret key as hex, prefixed with the algorithm tag (`01` Ed25519, `02` secp256k1). A `0x`-prefixed EVM key is rejected at startup with an explicit error.
- **Asset** — Casper assets are CEP-18 contract package hashes (64 hex chars, no `0x`). Use the `asset` value advertised in the server's 402 response, verify it on the explorer, then add it to `X402_ALLOWED_ASSETS`.
- **Limits** — `X402_MAX_PAYMENT` and `X402_MAX_SPEND_PER_SESSION` are in the asset's smallest unit, so size them for the Casper token's decimals.
- **Facilitator** — `https://x402-facilitator.cspr.cloud` (see [docs.cspr.cloud](https://docs.cspr.cloud)). It is chosen by the paid MCP server; the proxy only signs.
- **Testnet funds** — get testnet CSPR from the [Casper Testnet faucet](https://testnet.cspr.live/tools/faucet).

## What is x402?

[x402](https://docs.cdp.coinbase.com/x402/welcome) is an open protocol by Coinbase that enables instant, pay-per-request API access using stablecoin payments over HTTP. When an API returns HTTP 402, the client signs a USDC transfer authorization, and the server's facilitator executes the on-chain payment only after successfully delivering the response.

Key properties:
- **No subscription needed** — pay per request with USDC
- **Pay only on success** — if the server fails to return data, the signed authorization expires unused and no payment is deducted
- **Works on Base** (EVM) and **Solana** (plus **Casper** in this proxy, opt-in)

## Project Structure

```
x402-mcp-proxy/
├── src/index.ts           # Proxy entry point
├── src/casper.ts          # Optional Casper (casper:*) payment rail
├── src/limits.ts          # Payment safety limits (env parsing)
├── test/                  # Tests (pnpm test)
├── x402-mcps.example.json # Example remote MCP config
├── .env.example           # Example environment variables
├── package.json
├── tsconfig.json
└── LICENSE                # MIT
```

## Security Considerations

### Trust Model

This proxy is designed to run **locally on your own machine** as a stdio-based MCP server. The AI client (Claude, Cursor, etc.) communicates with it over stdin/stdout — there is no network listener. Authentication between the client and the proxy is therefore handled by OS-level process isolation.

If you deploy this proxy in a **shared or multi-user environment** (e.g., a server accessed by multiple users), you should add an authentication layer in front of it. The default stdio transport is not designed for that use case.

### Private Key Storage

Private keys are loaded from environment variables (typically a `.env` file). For personal / development use this is acceptable, but for production or high-value wallets consider:

- **OS keychain** integration (macOS Keychain, Linux secret-service)
- **Hardware wallets** or **cloud KMS** (AWS KMS, GCP Cloud KMS)
- **Encrypted env files** with a passphrase

Never commit `.env` files containing real private keys to version control.

### Built-in Protections

The proxy ships with several safety checks enabled by default:

- **Per-request amount cap** — rejects 402 responses that request more than the configured limit
- **Session spending cap** — stops signing once cumulative spend reaches the threshold
- **Network & asset allowlists** — only pays on explicitly permitted chains and tokens
- **HTTPS enforcement** — warns at startup if any remote MCP URL uses an insecure protocol (non-localhost HTTP)
- **Sanitised error output** — internal error details are not leaked to clients
- **Structured payment audit log** — every signed payment is logged to stderr with amount, network, asset, recipient, and target URL

## License

[MIT](LICENSE)
