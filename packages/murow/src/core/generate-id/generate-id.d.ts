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
export declare function generateId(options?: GenerateIdOptions): string;
export {};
