/**
 * Annex-B (start-code delimited) → AVCC (length-prefixed) for WebCodecs.
 *
 * The casting extensions hand out Annex-B, which is what a player wants but
 * what `VideoDecoder` cannot take directly: for `avc1` it needs one
 * length-prefixed sample plus an `avcC` record as `description`. Both are pure
 * byte work, so they live here and are tested without a browser or a device.
 */

const NAL_IDR = 5;
const NAL_SPS = 7;
const NAL_PPS = 8;

export { NAL_IDR, NAL_SPS, NAL_PPS };

/**
 * Splits an Annex-B buffer into NAL units, dropping the start codes.
 *
 * Handles both the 3-byte and 4-byte forms and the 4-byte form's leading zero,
 * which is what the device actually emits. Trailing bytes after the last start
 * code are kept: a frame can end mid-unit when the caller sliced it.
 */
export function splitNalUnits(annexB: Buffer): Buffer[] {
  const starts: number[] = [];
  const headerEnds: number[] = [];
  for (let i = 0; i + 3 <= annexB.length; i++) {
    if (annexB[i] !== 0 || annexB[i + 1] !== 0) continue;
    if (annexB[i + 2] === 1) {
      starts.push(i);
      headerEnds.push(i + 3);
      i += 2;
    } else if (annexB[i + 2] === 0 && i + 4 <= annexB.length && annexB[i + 3] === 1) {
      starts.push(i);
      headerEnds.push(i + 4);
      i += 3;
    }
  }
  if (starts.length === 0) return [];
  const units: Buffer[] = [];
  for (let k = 0; k < starts.length; k++) {
    const from = headerEnds[k]!;
    const to = k + 1 < starts.length ? starts[k + 1]! : annexB.length;
    if (to > from) units.push(annexB.subarray(from, to));
  }
  return units;
}

/** The NAL unit type: the low five bits of the header byte. */
export function nalType(unit: Buffer): number {
  const first = unit[0];
  if (first === undefined) throw new Error("empty NAL unit has no type");
  return first & 0x1f;
}

/** `avc1.PPCCLL` from an SPS: profile, constraints, level. */
export function codecString(sps: Buffer): string {
  if (sps.length < 4) throw new Error("SPS is too short to carry a profile and level");
  if (nalType(sps) !== NAL_SPS) throw new Error(`expected an SPS (type 7), got type ${nalType(sps)}`);
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `avc1.${hex(sps[1]!)}${hex(sps[2]!)}${hex(sps[3]!)}`;
}

/**
 * Prefixes each unit with its 32-bit length.
 *
 * This is the `lengthSizeMinusOne = 3` form the avcC record below declares, so
 * the two must be produced together.
 */
export function toAvcc(units: Buffer[]): Buffer {
  let total = 0;
  for (const unit of units) total += 4 + unit.length;
  const out = Buffer.allocUnsafe(total);
  let at = 0;
  for (const unit of units) {
    out.writeUInt32BE(unit.length, at);
    unit.copy(out, at + 4);
    at += 4 + unit.length;
  }
  return out;
}

/**
 * The AVCDecoderConfigurationRecord: what `VideoDecoder.configure` calls
 * `description` for an `avc1` codec string.
 */
export function avcC(sps: Buffer, pps: Buffer): Buffer {
  if (sps.length === 0) throw new Error("avcC needs an SPS");
  if (pps.length === 0) throw new Error("avcC needs a PPS");
  const out = Buffer.allocUnsafe(11 + sps.length + pps.length);
  out[0] = 1; // configurationVersion
  out[1] = sps[1] ?? 0; // AVCProfileIndication
  out[2] = sps[2] ?? 0; // profile_compatibility
  out[3] = sps[3] ?? 0; // AVCLevelIndication
  out[4] = 0xff; // reserved(6) + lengthSizeMinusOne(2) = 3
  out[5] = 0xe1; // reserved(3) + numOfSequenceParameterSets(5) = 1
  out.writeUInt16BE(sps.length, 6);
  sps.copy(out, 8);
  const at = 8 + sps.length;
  out[at] = 1; // numOfPictureParameterSets
  out.writeUInt16BE(pps.length, at + 1);
  pps.copy(out, at + 3);
  return out;
}

/** SPS/PPS carried in one frame's NAL units, if both are present. */
export function parameterSets(units: Buffer[]): { sps: Buffer; pps: Buffer } | null {
  let sps: Buffer | null = null;
  let pps: Buffer | null = null;
  for (const unit of units) {
    const type = nalType(unit);
    if (type === NAL_SPS && !sps) sps = unit;
    else if (type === NAL_PPS && !pps) pps = unit;
  }
  return sps && pps ? { sps, pps } : null;
}
