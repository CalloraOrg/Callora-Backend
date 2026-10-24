import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";

export const contractId = z
  .string()
  .trim()
  .min(1)
  .refine((v) => StrKey.isValidContract(v), {
    message: "must be a valid Stellar contract id (C...)",
  });

export const publicKey = z
  .string()
  .trim()
  .min(1)
  .refine((v) => StrKey.isValidEd25519PublicKey(v), {
    message: "must be a valid Stellar public key (G...)",
  });

export const secretKey = z
  .string()
  .trim()
  .min(1)
  .refine((v) => StrKey.isValidEd25519SecretSeed(v), {
    message: "must be a valid Stellar secret seed (S...)",
  });
