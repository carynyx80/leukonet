/**
 * Pure helpers shared by the server and the browser watcher: no Node APIs,
 * no NEAR SDK. Everything here must run unchanged in both places.
 */

/** NEAR -> yoctoNEAR (1 NEAR = 10^24 yocto), precise to a millionth of a NEAR. */
export const near = (n: number | string) => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 18n;

export const fmtNear = (y: bigint | string, digits = 3) => (Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(digits);

/** Base64 -> bytes, without Node's Buffer. */
export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const bytesToText = (b: Uint8Array) => new TextDecoder().decode(b);

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Bytes -> base58 (how NEAR writes hashes and keys). */
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
