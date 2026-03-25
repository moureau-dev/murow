interface GenerateIdOptions {
  /** Optional prefix to prepend to the ID */
  prefix?: string;
  /** Total length of the returned ID including prefix (default 16) */
  size?: number;
}

/**
 * @description
 * Generates a unique identifier as a hexadecimal string.
 * Can include a prefix and a custom total length.
 *
 * @param options Optional configuration: prefix and total size
 * @returns A unique identifier string
 *
 * @example
 * generateId(); // "f3a2b1c4d5e67890"
 * generateId({ prefix: 'user_' }); // "user_f3a2b1c4d5e67890"
 * generateId({ prefix: 'user_', size: 24 }); // "user_00f3a2b1c4d5e67890"
 */
export function generateId(options: GenerateIdOptions = {}): string {
  const { prefix = "", size = 16 } = options;

  // compute number of hex characters to generate (subtract prefix length)
  const hexLength = Math.max(size - prefix.length, 8); // min 8 hex chars

  // number of 32-bit integers needed to cover the hexLength
  const numInts = Math.ceil(hexLength / 8);

  const arr = crypto.getRandomValues(new Uint32Array(numInts));
  let id = arr.reduce((acc, val) => acc + val.toString(16).padStart(8, "0"), "");

  // truncate/pad to desired length
  id = id.slice(0, hexLength).padStart(hexLength, "0");

  return `${prefix}${id}`;
}
