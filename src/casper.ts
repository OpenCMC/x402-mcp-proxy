import type { x402Client } from "@x402/axios";
import { ExactCasperScheme } from "@make-software/casper-x402/exact/client";
import { toClientCasperSigner } from "@make-software/casper-x402";
import { KeyAlgorithm, PrivateKey } from "casper-js-sdk";

// ---------------------------------------------------------------------------
// Casper payment rail (opt-in via CASPER_PRIVATE_KEY)
// ---------------------------------------------------------------------------
export const CASPER_NETWORK_MAINNET = "casper:casper";
export const CASPER_NETWORK_TESTNET = "casper:casper-test";

const CASPER_KEY_PATTERN = /^(01|02)([0-9a-fA-F]{64})$/;

/**
 * Parse CASPER_PRIVATE_KEY into a casper-js-sdk PrivateKey.
 *
 * Expected format: algorithm tag + 32-byte secret key as hex (66 chars):
 *   "01" + 64 hex chars — Ed25519
 *   "02" + 64 hex chars — secp256k1
 */
export function parseCasperPrivateKey(raw: string): PrivateKey {
  const value = raw.trim();

  if (/^0x/i.test(value)) {
    throw new Error(
      "CASPER_PRIVATE_KEY looks like an EVM key (0x-prefixed). " +
        "Expected a Casper secret key as hex: \"01\" + 64 hex chars (Ed25519) " +
        "or \"02\" + 64 hex chars (secp256k1). Use EVM_PRIVATE_KEY for EVM keys.",
    );
  }

  const match = CASPER_KEY_PATTERN.exec(value);
  if (!match) {
    throw new Error(
      "CASPER_PRIVATE_KEY is invalid. Expected \"01\" + 64 hex chars (Ed25519) " +
        "or \"02\" + 64 hex chars (secp256k1).",
    );
  }

  const algorithm = match[1] === "01" ? KeyAlgorithm.ED25519 : KeyAlgorithm.SECP256K1;
  return PrivateKey.fromHex(match[2], algorithm);
}

/**
 * Register the Casper "exact" scheme for all casper:* networks.
 * No-op when no key is provided, so existing EVM/Solana setups are unaffected.
 */
export function registerCasperScheme(
  client: x402Client,
  casperPrivateKey: string | undefined,
): boolean {
  if (!casperPrivateKey) return false;

  const signer = toClientCasperSigner(parseCasperPrivateKey(casperPrivateKey));
  client.register("casper:*", new ExactCasperScheme(signer));
  return true;
}
