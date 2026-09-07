/**
 * CODAL friendly-name encoding.
 *
 * A micro:bit's five-letter name is a base-5 encoding of the target
 * nRF chip's `FICR.DEVICEID[1]` (see specification.md §2.2, §3.1).
 *
 * Direct port of mbdeploy's `friendly_name()`
 * (`mbdeploy/src/mbdeploy/devices.py:205-218`): the 32-bit chip id is
 * written out as five base-5 digits, and digit *i* (counting from the
 * LEAST significant, i = 0..4) selects a letter from column *i* of the
 * codebook below, landing at name position `4 - i`.
 *
 * Positions 0, 2, 4 are consonants; positions 1, 3 are vowels — which
 * is already how the codebook below is laid out (columns 0/2/4 are the
 * `zvgpt` consonant set, columns 1/3 are the `uoiea` vowel set), so no
 * separate consonant/vowel table is needed.
 *
 * Worked example (from devices.py's own docstring):
 * `2314287040 -> "tovez"`.
 */
export const NAME_CODEBOOK: readonly [string, string, string, string, string] = [
  "zvgpt",
  "uoiea",
  "zvgpt",
  "uoiea",
  "zvgpt",
];

const NAME_LENGTH = 5;

/** The size of the friendly-name space: 5^5 = 3125 distinct names. */
export const NAME_SPACE = 5 ** NAME_LENGTH;

/** `^[zvgpt][uoiea][zvgpt][uoiea][zvgpt]$` — a well-formed friendly name. */
const NAME_PATTERN = /^[zvgpt][uoiea][zvgpt][uoiea][zvgpt]$/;

/**
 * Numeric chip id (`FICR.DEVICEID[1]`, an unsigned 32-bit value) -> the
 * five-letter friendly name.
 *
 * Only the id's low 5 base-5 digits determine the name — mirrors
 * Python's `device_id & 0xFFFFFFFF` via JS's `>>> 0` (unsigned 32-bit
 * truncation), then five `% 5` / `// 5` steps.
 */
export function deviceIdToName(deviceId: number): string {
  let n = deviceId >>> 0;
  const letters: string[] = new Array(NAME_LENGTH).fill("");
  for (let i = 0; i < NAME_LENGTH; i++) {
    // Digit i (least-significant-first) selects codebook column i and
    // lands at name position (4 - i).
    const column = NAME_CODEBOOK[i]!;
    letters[NAME_LENGTH - 1 - i] = column[n % 5]!;
    n = Math.floor(n / 5);
  }
  return letters.join("");
}

/**
 * Five-letter name -> its base-5 value `n` in `[0, 3124]`, with
 * `name[0]` as the MOST significant digit.
 *
 * This is the exact inverse of `deviceIdToName`'s digit/position
 * mapping: digit *i* (least-significant-first) lands at position
 * `4 - i`, so position *p* holds digit `i = 4 - p`. Walking positions
 * `0..4` therefore walks digits from most to least significant, which
 * is the standard base-5 accumulation `n = n*5 + digit` used below —
 * it is written independently of `deviceIdToName` (not derived from
 * it), which is why the round-trip test in `naming.test.ts` is a real
 * check and not a tautology.
 *
 * `radioAddress.ts` builds `(channel, group)` on top of this.
 */
export function nameToValue(name: string): number {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`not a well-formed micro:bit name: ${JSON.stringify(name)}`);
  }
  let n = 0;
  for (let p = 0; p < NAME_LENGTH; p++) {
    const column = NAME_CODEBOOK[p]!;
    const letter = name[p]!;
    n = n * 5 + column.indexOf(letter);
  }
  return n;
}
