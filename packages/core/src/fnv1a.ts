/**
 * FNV-1a 32-bit hash — shared deterministic string hash (no external dep).
 * Returns the unsigned 32-bit result; callers pick the encoding they need
 * (base36 ids, zero-padded hex, or a raw int for slot selection).
 */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
