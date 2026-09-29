export interface AgentResolverGuardRequirement {
  scheme?: string;
  network?: string;
  asset?: string;
  payTo?: string;
  amount?: string;
  maxAmountRequired?: string;
}

type GuardTargetPayment = {
  network?: string | null;
  asset?: string | null;
  payTo?: string | null;
  amountAtomic?: string | null;
  scheme?: string | null;
};

type GuardResult = {
  observation?: {
    mode?: string;
    observedStatus?: number;
    safeProbeMethod?: string;
    safeProbeStatus?: number;
    targetRequestReplayed?: boolean;
  };
  guard?: {
    decision?: "eligible" | "blocked";
    eligibleForCallerAuthorization?: boolean;
    reasonCodes?: string[];
  };
  prepaymentDecision?: {
    decision?: "eligible" | "blocked";
    eligibleForCallerAuthorization?: boolean;
    reasons?: string[];
    targetPayment?: GuardTargetPayment;
  };
};

const DEFAULT_GUARD_URL =
  "https://agentresolver.vercel.app/api/payment-guard";

export function agentResolverGuardEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.AGENTRESOLVER_GUARD === "1";
}

export function selectGuardRequirement<T extends AgentResolverGuardRequirement>(
  accepts: readonly T[] | undefined,
  wallets: { evm: boolean; svm: boolean },
): T | null {
  if (!Array.isArray(accepts)) return null;

  return (
    accepts.find((requirement) => {
      const network = requirement.network ?? "";
      const amount = requirement.amount ?? requirement.maxAmountRequired;
      const networkSupported =
        (wallets.evm && network.startsWith("eip155:")) ||
        (wallets.svm && network.startsWith("solana:"));
      const amountIsPositiveInteger =
        typeof amount === "string" &&
        /^\d+$/.test(amount) &&
        BigInt(amount) > 0n;
      return (
        requirement.scheme === "exact" &&
        networkSupported &&
        Boolean(requirement.asset?.trim()) &&
        Boolean(requirement.payTo?.trim()) &&
        amountIsPositiveInteger
      );
    }) ?? null
  );
}

export function bindGuardedRequirement<
  TRequirement,
  TPaymentRequired extends { accepts: TRequirement[] },
>(
  paymentRequired: TPaymentRequired,
  requirement: TRequirement,
): TPaymentRequired {
  return {
    ...paymentRequired,
    accepts: [requirement],
  };
}

function normalizeAddress(value: string): string {
  return value.startsWith("0x") ? value.toLowerCase() : value;
}

function assertMatches(
  label: string,
  observed: string | null | undefined,
  expected: string | undefined,
  normalize = (value: string) => value,
): void {
  if (typeof expected !== "string" || !expected.trim()) {
    throw new Error("AgentResolver payment requirement is missing " + label);
  }
  if (!observed || normalize(observed) !== normalize(expected)) {
    throw new Error(
      "AgentResolver evidence mismatch for " +
        label +
        ": expected " +
        expected +
        ", observed " +
        (observed ?? "missing"),
    );
  }
}

export async function assertAgentResolverGuard(options: {
  guardFetch: typeof globalThis.fetch;
  requestUrl: string;
  method: string;
  paymentRequired: unknown;
  requirement: AgentResolverGuardRequirement;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<void> {
  const env = options.env ?? process.env;
  const endpoint = new URL(
    env.AGENTRESOLVER_GUARD_URL?.trim() || DEFAULT_GUARD_URL,
  );
  if (endpoint.protocol !== "https:") {
    throw new Error("AGENTRESOLVER_GUARD_URL must use HTTPS");
  }

  const method = options.method.toUpperCase();
  if (!["GET", "HEAD", "POST"].includes(method)) {
    throw new Error(
      "AgentResolver Guard does not support preflighting " + method + " requests",
    );
  }

  const payload: Record<string, unknown> = {
    url: options.requestUrl,
    method,
    observedStatus: 402,
    observedPaymentRequired: options.paymentRequired,
    expectedPayTo: options.requirement.payTo,
    expectedNetwork: options.requirement.network,
  };

  // guardFetch is payment-enabled, but intentionally not Guard-wrapped.
  // This prevents the $0.001 AgentResolver fee from recursively invoking Guard.
  const response = await options.guardFetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(
      "AgentResolver Guard failed closed: HTTP " + response.status,
    );
  }

  const result = (await response.json()) as GuardResult;

  if (result.observation?.mode !== "caller-observed-challenge") {
    throw new Error(
      "AgentResolver Guard did not confirm validation of the supplied 402 challenge",
    );
  }
  if (result.observation.targetRequestReplayed !== false) {
    throw new Error(
      "AgentResolver Guard did not confirm side-effect-safe target verification",
    );
  }

  const decision = result.prepaymentDecision ?? result.guard;

  if (
    decision?.decision !== "eligible" ||
    decision?.eligibleForCallerAuthorization !== true
  ) {
    const reasons =
      "reasons" in (decision ?? {})
        ? (decision as GuardResult["prepaymentDecision"])?.reasons
        : result.guard?.reasonCodes;
    throw new Error(
      "AgentResolver blocked target payment: " +
        ((reasons ?? []).join(", ") || "unknown_reason"),
    );
  }

  const target = result.prepaymentDecision?.targetPayment;
  if (!target) {
    throw new Error("AgentResolver Guard returned no target payment evidence");
  }

  assertMatches("network", target.network, options.requirement.network);
  assertMatches(
    "asset",
    target.asset,
    options.requirement.asset,
    normalizeAddress,
  );
  assertMatches(
    "payTo",
    target.payTo,
    options.requirement.payTo,
    normalizeAddress,
  );
  assertMatches("scheme", target.scheme, options.requirement.scheme);

  const expectedAmount =
    options.requirement.amount ?? options.requirement.maxAmountRequired;
  assertMatches("amount", target.amountAtomic, expectedAmount);
}
