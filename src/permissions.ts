export type PermissionLike =
  | number
  | bigint
  | string
  | { bitfield?: number | bigint | string | null | undefined }
  | null
  | undefined;

/**
 * Normalize Fluxer permission inputs into bigint-safe values.
 *
 * NOTE: this utility is prep work for upcoming @fluxerjs/util bigint permission internals.
 */
export function normalizePermissionBits(value: PermissionLike): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new Error("Permission bits number must be a non-negative integer");
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error("Permission bits string cannot be empty");
    }
    return BigInt(trimmed);
  }
  if (value && typeof value === "object" && "bitfield" in value) {
    return normalizePermissionBits(value.bitfield);
  }
  throw new Error("Unsupported permission bitfield value");
}

export function hasPermissionBits(
  subject: PermissionLike,
  required: PermissionLike,
): boolean {
  const subjectBits = normalizePermissionBits(subject);
  const requiredBits = normalizePermissionBits(required);
  return (subjectBits & requiredBits) === requiredBits;
}
