import { isValidStellarPublicKey } from './stellarAddress.js';

describe('isValidStellarPublicKey', () => {
  it('accepts a checksum-valid ed25519 public key', () => {
    expect(
      isValidStellarPublicKey('GCLH2SNM5MTV4TGNNOADLYOZJYIFBXTIDVSNW4XP3LEI2UQV2MZ46OD7')
    ).toBe(true);
  });

  it('rejects a key with the wrong prefix', () => {
    expect(
      isValidStellarPublicKey('XCLH2SNM5MTV4TGNNOADLYOZJYIFBXTIDVSNW4XP3LEI2UQV2MZ46OD7')
    ).toBe(false);
  });

  it('rejects keys that are too short or too long', () => {
    expect(isValidStellarPublicKey('GAAAAAAAAA')).toBe(false);
    expect(
      isValidStellarPublicKey('GCLH2SNM5MTV4TGNNOADLYOZJYIFBXTIDVSNW4XP3LEI2UQV2MZ46OD7AA')
    ).toBe(false);
  });

  it('rejects a lowercased key', () => {
    expect(
      isValidStellarPublicKey('gclh2snm5mtv4tgnnoadlyozjyifbxtidvsnw4xp3lei2uqv2mz46od7')
    ).toBe(false);
  });

  it('rejects a key using characters outside the strkey base32 alphabet', () => {
    // 0, 1, 8, 9 are not part of the RFC 4648 base32 alphabet strkey uses.
    expect(
      isValidStellarPublicKey('G01890189018901890189018901890189018901890189018901890')
    ).toBe(false);
  });

  it('rejects a well-formed key with a bad checksum', () => {
    // Valid alphabet and length, wrong final checksum bytes.
    expect(
      isValidStellarPublicKey('GCLH2SNM5MTV4TGNNOADLYOZJYIFBXTIDVSNW4XP3LEI2UQV2MZ46AAA')
    ).toBe(false);
  });

  it('rejects empty and obviously non-key strings', () => {
    expect(isValidStellarPublicKey('')).toBe(false);
    expect(isValidStellarPublicKey('invalid')).toBe(false);
  });
});
