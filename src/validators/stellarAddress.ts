import { StrKey } from '@stellar/stellar-sdk';

/**
 * True if `key` is a checksum-valid Stellar ed25519 public key (starts with G).
 *
 * This performs full strkey validation (base32 alphabet plus CRC16 checksum),
 * not just a G-prefix/length shape check, so malformed keys are rejected at the
 * boundary instead of reaching the transaction builder.
 */
export function isValidStellarPublicKey(key: string): boolean {
  return StrKey.isValidEd25519PublicKey(key);
}
