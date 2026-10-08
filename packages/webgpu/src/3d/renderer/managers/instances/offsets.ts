/** Field offsets into the per-instance dynamic/static Float32Arrays. */

// --- Dynamic offset constants ---
export const DYN_PREV_PX = 0, DYN_PREV_PY = 1, DYN_PREV_PZ = 2;
export const DYN_CURR_PX = 3, DYN_CURR_PY = 4, DYN_CURR_PZ = 5;
export const DYN_PREV_RX = 6, DYN_PREV_RY = 7, DYN_PREV_RZ = 8;
export const DYN_CURR_RX = 9, DYN_CURR_RY = 10, DYN_CURR_RZ = 11;

// --- Static offset constants ---
export const STAT_SX = 0, STAT_SY = 1, STAT_SZ = 2;
export const STAT_CR = 3, STAT_CG = 4, STAT_CB = 5;
export const STAT_MATERIAL_ID = 6;
export const STAT_CUSTOM0 = 7, STAT_CUSTOM1 = 8;

// --- Skinned static offset constants (extra boneOffset) ---
export const SSTAT_SX = 0, SSTAT_SY = 1, SSTAT_SZ = 2;
export const SSTAT_CR = 3, SSTAT_CG = 4, SSTAT_CB = 5;
export const SSTAT_BONE_OFFSET = 6;
export const SSTAT_MATERIAL_ID = 7;
