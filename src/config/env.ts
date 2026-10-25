import "dotenv/config";
import { z } from "zod";
import { Keypair } from "@stellar/stellar-sdk";
import { serverEnvironmentFields } from "./server-env.js";
import { integrationEnvironmentFields } from "./integrations-env.js";
import { executionEnvironmentFields } from "./execution-env.js";
import { sloEnvironmentFields } from "./slo-env.js";

export const envSchema = z.object({
  ...serverEnvironmentFields,
  ...integrationEnvironmentFields,
  ...executionEnvironmentFields,
  ...sloEnvironmentFields,
})
  .superRefine((data, ctx) => {
    if (data.FEE_ABSTRACTION_RATE_DENOMINATOR === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["FEE_ABSTRACTION_RATE_DENOMINATOR"],
        message: "FEE_ABSTRACTION_RATE_DENOMINATOR must be greater than zero",
      });
    }

    if (data.EXPORTS_ENABLED) {
      for (const [key, value] of [
        ["EXPORTS_S3_BUCKET", data.EXPORTS_S3_BUCKET],
        ["EXPORTS_S3_ENDPOINT", data.EXPORTS_S3_ENDPOINT],
        ["EXPORTS_S3_REGION", data.EXPORTS_S3_REGION],
        ["EXPORTS_SIGNING_SECRET", data.EXPORTS_SIGNING_SECRET],
      ] as const) {
        if (!value) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when EXPORTS_ENABLED=true`,
          });
        }
      }
    }

    if (data.NODE_ENV === "production" && data.FORWARDED_IDENTITY_ALLOW_LEGACY) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["FORWARDED_IDENTITY_ALLOW_LEGACY"], message: "Legacy forwarded identities are forbidden in production" });
    }
    if (data.NODE_ENV === "production" && !data.DEMO_MODE && !data.SOROBAN_BILLING_CONTRACT_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SOROBAN_BILLING_CONTRACT_ID"],
        message: "SOROBAN_BILLING_CONTRACT_ID is required in production",
      });
    }

    if (data.SOROBAN_RPC_ENABLED && !data.SOROBAN_RPC_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SOROBAN_RPC_URL"],
        message: "SOROBAN_RPC_URL is required when SOROBAN_RPC_ENABLED=true",
      });
    }

    if (data.HORIZON_ENABLED && !data.HORIZON_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["HORIZON_URL"],
        message: "HORIZON_URL is required when HORIZON_ENABLED=true",
      });
    }

    // In production the upstream host allowlist must be explicitly configured.
    // The default empty allowlist rejects all upstream hosts, so operators
    // must set UPSTREAM_HOST_ALLOWLIST to a non-empty value to proxy traffic.
    if (
      data.NODE_ENV === "production" &&
      (!data.UPSTREAM_HOST_ALLOWLIST ||
        data.UPSTREAM_HOST_ALLOWLIST.trim() === "")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["UPSTREAM_HOST_ALLOWLIST"],
        message:
          "UPSTREAM_HOST_ALLOWLIST is required in production and must be a non-empty comma-separated list of allowed upstream hosts",
      });
    }

    // ──────────────────────────────────────────────────────────────────────
    // Stellar / Soroban network consistency checks.
    //
    // These run after the per-field StrKey refinements above, so by the time
    // we reach this block every contract id, public key and secret seed has
    // already been validated. The checks below only compare *validated*
    // values, so a mismatch here is always a real network/contract mismatch
    // rather than a typo in the key material.
    //
    // IMPORTANT: never interpolate a secret value into an issue message.
    // Only the variable name and the failing rule are reported.
    // ──────────────────────────────────────────────────────────────────────
    const activeNetwork = data.STELLAR_NETWORK ?? data.SOROBAN_NETWORK;

    const activeNetworkPassphrase =
      activeNetwork === "mainnet"
        ? "Public Global Stellar Network ; September 2015"
        : activeNetwork === "testnet"
          ? "Test SDF Network ; September 2015"
          : undefined;

    const activeNetworkRpcUrl =
      activeNetwork === "mainnet"
        ? data.SOROBAN_MAINNET_RPC_URL
        : activeNetwork === "testnet"
          ? data.SOROBAN_TESTNET_RPC_URL
          : undefined;

    const activeVaultContractId =
      activeNetwork === "mainnet"
        ? data.STELLAR_MAINNET_VAULT_CONTRACT_ID
        : activeNetwork === "testnet"
          ? data.STELLAR_TESTNET_VAULT_CONTRACT_ID
          : undefined;

    // 1. Billing passphrase must match the active network when both are set.
    if (
      data.SOROBAN_BILLING_NETWORK_PASSPHRASE !== undefined &&
      activeNetworkPassphrase !== undefined &&
      data.SOROBAN_BILLING_NETWORK_PASSPHRASE !== activeNetworkPassphrase
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SOROBAN_BILLING_NETWORK_PASSPHRASE"],
        message:
          "SOROBAN_BILLING_NETWORK_PASSPHRASE does not match the active STELLAR_NETWORK; unset it to derive from the network or set it to the active network's passphrase",
      });
    }

    // 2. Production must not silently run against the testnet passphrase.
    if (
      data.NODE_ENV === "production" &&
      activeNetwork === "testnet" &&
      !data.ALLOW_TESTNET_IN_PRODUCTION
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["STELLAR_NETWORK"],
        message:
          "STELLAR_NETWORK=testnet is not allowed in production unless ALLOW_TESTNET_IN_PRODUCTION=true",
      });
    }

    // 3. Production must not fall back to the localhost Soroban RPC.
    if (
      data.NODE_ENV === "production" &&
      data.SOROBAN_BILLING_RPC_URL === undefined &&
      data.SOROBAN_RPC_URL === undefined &&
      activeNetworkRpcUrl === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SOROBAN_BILLING_RPC_URL"],
        message:
          "SOROBAN_BILLING_RPC_URL (or SOROBAN_RPC_URL) is required in production; the localhost fallback is disabled outside development and test",
      });
    }

    // 4. Billing contract id must agree with the active vault id. When it
    //    differs it is treated as an explicit override and logged once at
    //    startup (see src/services/createSorobanBillingService.ts).
    if (
      data.SOROBAN_BILLING_CONTRACT_ID !== undefined &&
      activeVaultContractId !== undefined &&
      data.SOROBAN_BILLING_CONTRACT_ID !== activeVaultContractId
    ) {
      // No issue: this is a supported override. The warning is emitted by
      // the billing service factory so it fires exactly once per process.
    }

    // 5. The billing secret key must derive the configured source account.
    //    The public key is computed lazily here to avoid pulling the StrKey
    //    dependency into the hot path when the secret is unset.
    if (
      data.SOROBAN_BILLING_BACKEND_SECRET_KEY !== undefined &&
      data.SOROBAN_BILLING_SOURCE_ACCOUNT !== undefined
    ) {
      let derivedPublicKey: string | undefined;
      try {
        derivedPublicKey = Keypair.fromSecret(
          data.SOROBAN_BILLING_BACKEND_SECRET_KEY,
        ).publicKey();
      } catch {
        derivedPublicKey = undefined;
      }
      if (
        derivedPublicKey !== undefined &&
        derivedPublicKey !== data.SOROBAN_BILLING_SOURCE_ACCOUNT
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["SOROBAN_BILLING_BACKEND_SECRET_KEY"],
          message:
            "SOROBAN_BILLING_BACKEND_SECRET_KEY does not derive SOROBAN_BILLING_SOURCE_ACCOUNT",
        });
      }
    }
  });

export type EnvSchema = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment configuration:");
  parsed.error.issues.forEach((issue) => {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  });
  process.exit(1);
}

export const env = parsed.data;
