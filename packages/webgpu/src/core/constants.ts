/**
 * Memory layout constants for the 2D renderer.
 *
 * Dynamic data: updated every tick (positions, rotation).
 * Static data: rarely changes (UVs, tint, opacity, scale).
 *
 * Laid out as flat Float32Arrays for zero-GC GPU uploads.
 */

// --- 2D Dynamic layout (per instance) ---
// Previous frame position (for interpolation)
export const DYNAMIC_OFFSET_PREV_X = 0;
export const DYNAMIC_OFFSET_PREV_Y = 1;
// Current frame position
export const DYNAMIC_OFFSET_CURR_X = 2;
export const DYNAMIC_OFFSET_CURR_Y = 3;
// Rotation (previous + current for interpolation)
export const DYNAMIC_OFFSET_PREV_ROTATION = 4;
export const DYNAMIC_OFFSET_CURR_ROTATION = 5;
export const DYNAMIC_FLOATS_PER_SPRITE = 6;

// --- 2D Static layout (per instance) ---
export const STATIC_OFFSET_SCALE_X = 0;
export const STATIC_OFFSET_SCALE_Y = 1;
export const STATIC_OFFSET_UV_MIN_X = 2;
export const STATIC_OFFSET_UV_MIN_Y = 3;
export const STATIC_OFFSET_UV_MAX_X = 4;
export const STATIC_OFFSET_UV_MAX_Y = 5;
export const STATIC_OFFSET_LAYER = 6;
export const STATIC_OFFSET_FLIP_X = 7;
export const STATIC_OFFSET_FLIP_Y = 8;
export const STATIC_OFFSET_OPACITY = 9;
export const STATIC_OFFSET_TINT_R = 10;
export const STATIC_OFFSET_TINT_G = 11;
export const STATIC_OFFSET_TINT_B = 12;
export const STATIC_OFFSET_TINT_A = 13;
export const STATIC_FLOATS_PER_SPRITE = 14;

// --- 3D Dynamic layout (per instance) ---
export const DYNAMIC_3D_OFFSET_PREV_POS_X = 0;
export const DYNAMIC_3D_OFFSET_PREV_POS_Y = 1;
export const DYNAMIC_3D_OFFSET_PREV_POS_Z = 2;
export const DYNAMIC_3D_OFFSET_CURR_POS_X = 3;
export const DYNAMIC_3D_OFFSET_CURR_POS_Y = 4;
export const DYNAMIC_3D_OFFSET_CURR_POS_Z = 5;
// Previous rotation quaternion
export const DYNAMIC_3D_OFFSET_PREV_ROT_X = 6;
export const DYNAMIC_3D_OFFSET_PREV_ROT_Y = 7;
export const DYNAMIC_3D_OFFSET_PREV_ROT_Z = 8;
export const DYNAMIC_3D_OFFSET_PREV_ROT_W = 9;
// Current rotation quaternion
export const DYNAMIC_3D_OFFSET_CURR_ROT_X = 10;
export const DYNAMIC_3D_OFFSET_CURR_ROT_Y = 11;
export const DYNAMIC_3D_OFFSET_CURR_ROT_Z = 12;
export const DYNAMIC_3D_OFFSET_CURR_ROT_W = 13;
export const DYNAMIC_3D_FLOATS_PER_INSTANCE = 14;

// --- 3D Static layout (per instance) ---
export const STATIC_3D_OFFSET_SCALE_X = 0;
export const STATIC_3D_OFFSET_SCALE_Y = 1;
export const STATIC_3D_OFFSET_SCALE_Z = 2;
export const STATIC_3D_OFFSET_MATERIAL_ID = 3;
export const STATIC_3D_OFFSET_OPACITY = 4;
export const STATIC_3D_OFFSET_TINT_R = 5;
export const STATIC_3D_OFFSET_TINT_G = 6;
export const STATIC_3D_OFFSET_TINT_B = 7;
export const STATIC_3D_OFFSET_TINT_A = 8;
export const STATIC_3D_OFFSET_CUSTOM_0 = 9;
export const STATIC_3D_OFFSET_CUSTOM_1 = 10;
export const STATIC_3D_FLOATS_PER_INSTANCE = 11;

// Sentinel values
export const INVALID_INDEX = 0xFFFFFFFF;
export const INVALID_ENTITY = 0xFFFFFFFF;
