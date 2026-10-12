/**
 * Stable shader-authoring namespaces.
 *
 * Shader bodies are parsed from their source, so the `d`/`std` identifiers they
 * reference must survive bundling. A single local copy here keeps the names
 * stable (importing the raw namespaces lets a bundler rename them).
 */
import { d as dataNs, std as stdNs } from 'murow/gpu';

export const d: typeof dataNs = { ...dataNs };
export const std: typeof stdNs = { ...stdNs };
