/**
 * The generic `Bucket` base now lives in core (`core/bucket`) so that
 * non-renderer resource types (e.g. audio clips) can build on it without
 * depending on the renderer.
 *
 * Re-exported here to keep the renderer bucket module's public surface stable.
 */
export * from '../../../core/bucket/bucket';
