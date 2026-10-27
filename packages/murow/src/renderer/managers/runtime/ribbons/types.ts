import type { Logger } from 'murow/core';
import type { RawDevice, RawTextureFormat, RawTextureView } from 'murow/gpu';
import type { HandleBase } from '../../handle-base';
import type { BeamId, RibbonId, TrailId } from '../../types';
import type { RendererRuntime } from '../backend';
import type { LayerRegistry } from 'murow/renderer';

/** RGBA color with components in the 0..1 range. */
export type RibbonColor = readonly [number, number, number, number];

/** Start and end color, interpolated along the strip. */
export type RibbonGradient = readonly [RibbonColor, RibbonColor];

/** Width in world units, either constant or start-to-end. */
export type RibbonWidth = number | readonly [number, number];

/** Blend mode for ribbon geometry. */
export type RibbonBlend = 'alpha' | 'additive';

/** How a strip is oriented in 3D. */
export type RibbonFacing = 'camera' | 'up';

/** Capacity for every ribbon pool plus the shared geometry budget. */
export interface RibbonManagerCapacity {
    readonly maxRibbons: number;
    readonly maxTrails: number;
    readonly maxBeams: number;
    readonly maxVertices: number;
    readonly maxTrailPoints: number;
    readonly maxTotalTrailPoints: number;
}

export interface RibbonManagerDeps {
    readonly runtime: RendererRuntime;
    readonly device: RawDevice;
    readonly format: RawTextureFormat;
    readonly logger: Logger;
    readonly capacity: RibbonManagerCapacity;
    /** Resolve an asset texture id to a GPU view. Missing ids use white. */
    readonly resolveTexture?: (id: string) => RawTextureView | undefined;
    readonly layers?: LayerRegistry;
}

export interface LineOptions {
    /** Flat xyz triples. */
    readonly points: ArrayLike<number>;
    /** Optional point budget; defaults to the largest of 1024 and points.length / 3. */
    readonly maxPoints?: number;
    readonly width?: RibbonWidth;
    readonly color?: RibbonColor | RibbonGradient;
    readonly blend?: RibbonBlend;
    readonly depthTest?: boolean;
    readonly facing?: RibbonFacing;
    readonly texture?: string;
    readonly uvScale?: number;
    readonly layer?: number | string;
    readonly closed?: boolean;
}

export interface RibbonOptions {
    /** Flat xyz triples. Can also be set later with setPoints. */
    readonly points?: ArrayLike<number>;
    readonly maxPoints?: number;
    readonly width?: RibbonWidth;
    readonly color?: RibbonColor | RibbonGradient;
    readonly blend?: RibbonBlend;
    readonly depthTest?: boolean;
    readonly facing?: RibbonFacing;
    readonly texture?: string;
    readonly uvScale?: number;
    readonly layer?: number | string;
    readonly closed?: boolean;
}

export interface TrailOptions {
    readonly maxPoints?: number;
    readonly lifetime?: number;
    readonly minDistance?: number;
    readonly width?: RibbonWidth;
    readonly color?: RibbonGradient;
    readonly blend?: RibbonBlend;
    readonly depthTest?: boolean;
    readonly facing?: RibbonFacing;
    readonly texture?: string;
    readonly uvScale?: number;
    readonly layer?: number | string;
}

export interface BeamOptions {
    readonly width?: number;
    readonly color?: RibbonColor;
    readonly blend?: RibbonBlend;
    readonly depthTest?: boolean;
    readonly facing?: RibbonFacing;
    readonly texture?: string;
    readonly uvScale?: number;
    readonly layer?: number | string;
    readonly uvScroll?: number;
    readonly segments?: number;
    readonly noise?: number;
    readonly noiseFrequency?: number;
    /** How fast the wave pattern travels, in pattern-lengths per second. Default 1. Set 0 for a standing tether. */
    readonly noiseSpeed?: number;
}

/** A raw line or ribbon strip. */
export interface RibbonHandle extends HandleBase<RibbonId> {
    setPoints(points: ArrayLike<number>): void;
    setColor(r: number, g: number, b: number, a: number): void;
    setWidth(width: RibbonWidth): void;
    enabled: boolean;
}

/** Line is the same handle type as a raw ribbon. */
export type LineHandle = RibbonHandle;

/** A time-history ribbon attached to a moving head. */
export interface TrailHandle extends HandleBase<TrailId> {
    readonly maxPoints: number;
    readonly pointCount: number;
    readonly lifetime: number;
    setHead(x: number, y: number, z: number): void;
    setLifetime(seconds: number): void;
    setWidth(width: RibbonWidth): void;
    setColor(start: RibbonColor, end: RibbonColor): void;
    clear(): void;
    enabled: boolean;
}

/** A two-endpoint ribbon with optional UV scroll and noise. */
export interface BeamHandle extends HandleBase<BeamId> {
    set(fromX: number, fromY: number, fromZ: number, toX: number, toY: number, toZ: number): void;
    setWidth(width: number): void;
    setNoise(amount: number): void;
    setColor(r: number, g: number, b: number, a: number): void;
    enabled: boolean;
}
