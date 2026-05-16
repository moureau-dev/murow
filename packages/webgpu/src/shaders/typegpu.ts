/**
 * Bundler-safe wrappers around TypeGPU's `data` and `std` namespace exports.
 */

import * as _d from 'typegpu/data';
import * as _std from 'typegpu/std';

export const d: typeof _d = { ..._d };
export const std: typeof _std = { ..._std };
export type d = typeof _d;
export type std = typeof _std;
