// ---------------------------------------------------------------------------
// Payment safety limits
// ---------------------------------------------------------------------------
export interface PaymentLimits {
  maxPerRequest: bigint;
  maxPerSession: bigint;
  allowedNetworks: Set<string>;
  allowedAssets: Set<string>;
}

export function loadPaymentLimits(env: NodeJS.ProcessEnv = process.env): PaymentLimits {
  return {
    maxPerRequest: BigInt(env.X402_MAX_PAYMENT ?? "100000"),
    maxPerSession: BigInt(env.X402_MAX_SPEND_PER_SESSION ?? "1000000"),
    allowedNetworks: new Set(
      (env.X402_ALLOWED_NETWORKS ?? "eip155:8453,solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")
        .split(",").map((s) => s.trim()).filter(Boolean),
    ),
    allowedAssets: new Set(
      (
        env.X402_ALLOWED_ASSETS ??
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
      )
        .split(",").map((s) => s.trim()).filter(Boolean),
    ),
  };
}
