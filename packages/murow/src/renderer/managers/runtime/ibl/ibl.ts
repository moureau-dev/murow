import {
    RawBuffer,
    RawBufferUsage,
    RawDevice,
    RawSampler,
    RawTexture,
    RawTextureUsage,
    RawTextureView,
    d,
} from 'murow/gpu';

/** Uniform block shared by PBR materials for the active environment. */
export const IblUniforms = d.struct({
    /** Diffuse and specular multiplier. */
    intensity: d.f32,
    /** Environment rotation around Y in radians. */
    rotation: d.f32,
    /** Highest specular mip, used to map roughness. */
    maxMip: d.f32,
    /** 1 when an environment is loaded, 0 for the flat fallback. */
    enabled: d.f32,
});

/** Raw RGBA pixels in an equirectangular layout. */
export interface IblPixels {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
}

/** Pixels accepted as an equirectangular source. */
export type IblImage = HTMLCanvasElement | HTMLImageElement | ImageBitmap | ImageData | IblPixels;

/** Runtime IBL settings that can be updated together. */
export interface IblSetOptions {
    /** Diffuse and specular multiplier. */
    readonly intensity?: number;
    /** Environment rotation around Y in radians. */
    readonly rotation?: number;
}

/** Options for loading an equirectangular environment. */
export interface IblLoadOptions {
    /** Source image in equirectangular layout. */
    readonly equirect: IblImage;
    /** Diffuse and specular multiplier. Default 1. */
    readonly intensity?: number;
    /** Rotation around Y in radians. Default 0. */
    readonly rotation?: number;
    /** Skybox equirect width. Height is width / 2. Default 512. */
    readonly skyboxResolution?: number;
}

const FACE_SIZE = 64;
const IRRADIANCE_SIZE = 8;
const DEFAULT_SKYBOX_RESOLUTION = 512;
const LEVELS = Math.floor(Math.log2(FACE_SIZE)) + 1;
const FACE_COUNT = 6;

/**
 * Image-based lighting environment.
 *
 * Converts an equirectangular image to a cubemap, builds a box-filtered mip
 * chain for roughness-based specular, and convolves a small irradiance cubemap
 * for diffuse. All work happens on the CPU at load time.
 */
export class IblManager {
    /** Uniform block bound into every PBR material. */
    readonly uniformBuffer: RawBuffer;
    /** Prefiltered environment cubemap view. */
    readonly envView: RawTextureView;
    /** Irradiance cubemap view. */
    readonly irradianceView: RawTextureView;
    /** Equirectangular view used by the visible skybox. */
    equirectView!: RawTextureView;
    /** Shared sampler for both cubemaps. */
    readonly sampler: RawSampler;
    /** Repeat-U / clamp-V sampler for the equirect skybox. */
    readonly equirectSampler: RawSampler;

    private readonly envTexture: RawTexture;
    private readonly irradianceTexture: RawTexture;
    private equirectTexture!: RawTexture;
    private readonly uniformData = new Float32Array([1, 0, LEVELS - 1, 0]);
    private readonly black: Uint8Array;
    private enabled = false;
    private sourcePixels: Pixels | null = null;
    private equirectWidth = DEFAULT_SKYBOX_RESOLUTION;
    private equirectHeight = DEFAULT_SKYBOX_RESOLUTION / 2;
    /** Incremented when the equirect texture or view is recreated. */
    equirectVersion = 0;

    constructor(private readonly device: RawDevice) {
        this.envTexture = device.createTexture({
            size: [FACE_SIZE, FACE_SIZE, FACE_COUNT],
            dimension: '2d',
            format: 'rgba8unorm',
            mipLevelCount: LEVELS,
            usage: RawTextureUsage.TEXTURE_BINDING | RawTextureUsage.COPY_DST,
        });
        this.irradianceTexture = device.createTexture({
            size: [IRRADIANCE_SIZE, IRRADIANCE_SIZE, FACE_COUNT],
            dimension: '2d',
            format: 'rgba8unorm',
            mipLevelCount: 1,
            usage: RawTextureUsage.TEXTURE_BINDING | RawTextureUsage.COPY_DST,
        });
        this.createEquirectTexture();
        this.envView = this.envTexture.createView({ dimension: 'cube' });
        this.irradianceView = this.irradianceTexture.createView({ dimension: 'cube' });
        this.sampler = device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
        });
        this.equirectSampler = device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'repeat',
            addressModeV: 'clamp-to-edge',
        });
        this.uniformBuffer = device.createBuffer({
            size: IblUniforms.size,
            usage: RawBufferUsage.UNIFORM | RawBufferUsage.COPY_DST,
        });
        this.black = new Uint8Array(FACE_SIZE * FACE_SIZE * 4);
        this.writeBlack();
        this.writeUniforms();
    }

    /** Diffuse and specular multiplier. */
    get intensity(): number {
        return this.uniformData[0]!;
    }

    set intensity(value: number) {
        this.set({ intensity: value });
    }

    /** Environment rotation around Y in radians. */
    get rotation(): number {
        return this.uniformData[1]!;
    }

    set rotation(value: number) {
        this.set({ rotation: value });
    }

    /** Update several IBL settings with one uniform upload. */
    set(options: IblSetOptions): void {
        let changed = false;
        if (options.intensity !== undefined) {
            this.uniformData[0] = options.intensity;
            changed = true;
        }
        if (options.rotation !== undefined) {
            this.uniformData[1] = options.rotation;
            changed = true;
        }
        if (changed) this.writeUniforms();
    }

    /** Skybox equirect width. Height is width / 2. */
    get skyboxResolution(): number {
        return this.equirectWidth;
    }

    set skyboxResolution(width: number) {
        this.setSkyboxResolution(width);
    }

    /** Whether an environment is active. */
    get active(): boolean {
        return this.enabled;
    }

    /** Build and upload an environment from an equirectangular image. */
    async load(options: IblLoadOptions): Promise<void> {
        const source = readPixels(options.equirect);
        this.sourcePixels = source;
        if (options.skyboxResolution !== undefined) {
            this.setSkyboxResolution(options.skyboxResolution);
        }
        this.uploadEquirect(source);
        const base = equirectToCube(source, FACE_SIZE);
        const mips = buildMips(base, FACE_SIZE);
        const irradiance = buildIrradiance(base, FACE_SIZE, IRRADIANCE_SIZE);

        for (let level = 0; level < mips.length; level++) {
            const size = Math.max(1, FACE_SIZE >> level);
            for (let face = 0; face < FACE_COUNT; face++) {
                this.device.queue.writeTexture(
                    { texture: this.envTexture, mipLevel: level, origin: [0, 0, face] },
                    mips[level]![face]!,
                    { bytesPerRow: size * 4, rowsPerImage: size },
                    [size, size, 1],
                );
            }
        }
        for (let face = 0; face < FACE_COUNT; face++) {
            this.device.queue.writeTexture(
                { texture: this.irradianceTexture, mipLevel: 0, origin: [0, 0, face] },
                irradiance[face]!,
                { bytesPerRow: IRRADIANCE_SIZE * 4, rowsPerImage: IRRADIANCE_SIZE },
                [IRRADIANCE_SIZE, IRRADIANCE_SIZE, 1],
            );
        }

        this.uniformData[0] = options.intensity ?? this.uniformData[0]!;
        this.uniformData[1] = options.rotation ?? this.uniformData[1]!;
        this.uniformData[2] = LEVELS - 1;
        this.uniformData[3] = 1;
        this.enabled = true;
        this.writeUniforms();
    }

    /** Disable the environment. PBR falls back to the flat ambient term. */
    clear(): void {
        this.enabled = false;
        this.uniformData[3] = 0;
        this.writeUniforms();
        this.writeBlack();
    }

    /** Recreate the equirect texture at the configured resolution. */
    setSkyboxResolution(width: number): void {
        const next = Math.max(64, Math.min(4096, Math.round(width)));
        if (next === this.equirectWidth) return;
        this.equirectWidth = next;
        this.equirectHeight = Math.max(32, Math.round(next / 2));
        this.createEquirectTexture();
        if (this.sourcePixels) this.uploadEquirect(this.sourcePixels);
    }

    private createEquirectTexture(): void {
        this.equirectTexture?.destroy();
        this.equirectTexture = this.device.createTexture({
            size: [this.equirectWidth, this.equirectHeight, 1],
            dimension: '2d',
            format: 'rgba8unorm',
            mipLevelCount: 1,
            usage: RawTextureUsage.TEXTURE_BINDING | RawTextureUsage.COPY_DST,
        });
        this.equirectView = this.equirectTexture.createView();
        this.equirectVersion++;
    }

    /** Resample the source to the configured equirect size for the skybox. */
    private uploadEquirect(source: Pixels): void {
        const data = new Uint8Array(this.equirectWidth * this.equirectHeight * 4);
        for (let y = 0; y < this.equirectHeight; y++) {
            const v = ((y + 0.5) / this.equirectHeight) * source.height - 0.5;
            for (let x = 0; x < this.equirectWidth; x++) {
                const u = ((x + 0.5) / this.equirectWidth) * source.width - 0.5;
                const c = sampleEquirect(source, u, v);
                const i = (y * this.equirectWidth + x) * 4;
                data[i] = c[0];
                data[i + 1] = c[1];
                data[i + 2] = c[2];
                data[i + 3] = 255;
            }
        }
        this.device.queue.writeTexture(
            { texture: this.equirectTexture, mipLevel: 0, origin: [0, 0, 0] },
            data,
            { bytesPerRow: this.equirectWidth * 4, rowsPerImage: this.equirectHeight },
            [this.equirectWidth, this.equirectHeight, 1],
        );
    }

    private writeUniforms(): void {
        this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
    }

    /** Zero every mip so a cleared environment cannot leak the previous one. */
    private writeBlack(): void {
        const blackMips = buildMips([0, 1, 2, 3, 4, 5].map(() => this.black), FACE_SIZE);
        for (let level = 0; level < blackMips.length; level++) {
            const size = Math.max(1, FACE_SIZE >> level);
            for (let face = 0; face < FACE_COUNT; face++) {
                this.device.queue.writeTexture(
                    { texture: this.envTexture, mipLevel: level, origin: [0, 0, face] },
                    blackMips[level]![face]!,
                    { bytesPerRow: size * 4, rowsPerImage: size },
                    [size, size, 1],
                );
            }
        }
        const blackIrr = new Uint8Array(IRRADIANCE_SIZE * IRRADIANCE_SIZE * 4);
        for (let face = 0; face < FACE_COUNT; face++) {
            this.device.queue.writeTexture(
                { texture: this.irradianceTexture, mipLevel: 0, origin: [0, 0, face] },
                blackIrr,
                { bytesPerRow: IRRADIANCE_SIZE * 4, rowsPerImage: IRRADIANCE_SIZE },
                [IRRADIANCE_SIZE, IRRADIANCE_SIZE, 1],
            );
        }
    }
}

interface Pixels {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
}

function readPixels(source: IblImage): Pixels {
    const raw = source as IblPixels;
    if (raw && typeof raw.data !== 'undefined' && typeof raw.width === 'number') {
        return { data: raw.data, width: raw.width, height: raw.height };
    }
    if (typeof ImageData !== 'undefined' && source instanceof ImageData) {
        return { data: source.data, width: source.width, height: source.height };
    }
    const image = source as CanvasImageSource;
    const width = (source as { width?: number }).width ?? 1;
    const height = (source as { height?: number }).height ?? 1;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('ibl: cannot create a 2D context');
    ctx.drawImage(image, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
}

/** Convert an equirectangular image to six cube faces. */
function equirectToCube(source: Pixels, size: number): Uint8Array[] {
    const faces: Uint8Array[] = [];
    for (let face = 0; face < FACE_COUNT; face++) {
        const out = new Uint8Array(size * size * 4);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const u = ((x + 0.5) / size) * 2 - 1;
                const v = ((y + 0.5) / size) * 2 - 1;
                const dir = faceDirection(face, u, v);
                const phi = Math.atan2(dir[2], dir[0]);
                const theta = Math.acos(clamp(dir[1], -1, 1));
                const eu = ((phi + Math.PI) / (Math.PI * 2)) * source.width - 0.5;
                const ev = (theta / Math.PI) * source.height - 0.5;
                const c = sampleEquirect(source, eu, ev);
                const o = (y * size + x) * 4;
                out[o] = c[0];
                out[o + 1] = c[1];
                out[o + 2] = c[2];
                out[o + 3] = 255;
            }
        }
        faces.push(out);
    }
    return faces;
}

/** Box-filtered mip chain, one array per level, each containing six faces. */
function buildMips(base: Uint8Array[], size: number): Uint8Array[][] {
    const levels: Uint8Array[][] = [base];
    let src = base;
    let srcSize = size;
    while (srcSize > 1) {
        const dstSize = Math.max(1, srcSize >> 1);
        const dst: Uint8Array[] = [];
        for (let face = 0; face < FACE_COUNT; face++) {
            const out = new Uint8Array(dstSize * dstSize * 4);
            const input = src[face]!;
            for (let y = 0; y < dstSize; y++) {
                for (let x = 0; x < dstSize; x++) {
                    let r = 0, g = 0, b = 0;
                    for (let oy = 0; oy < 2; oy++) {
                        for (let ox = 0; ox < 2; ox++) {
                            const sx = Math.min(srcSize - 1, x * 2 + ox);
                            const sy = Math.min(srcSize - 1, y * 2 + oy);
                            const i = (sy * srcSize + sx) * 4;
                            r += input[i]!;
                            g += input[i + 1]!;
                            b += input[i + 2]!;
                        }
                    }
                    const o = (y * dstSize + x) * 4;
                    out[o] = r >> 2;
                    out[o + 1] = g >> 2;
                    out[o + 2] = b >> 2;
                    out[o + 3] = 255;
                }
            }
            dst.push(out);
        }
        levels.push(dst);
        src = dst;
        srcSize = dstSize;
    }
    return levels;
}

/** Cosine-convolve the base cubemap into a small irradiance cubemap. */
function buildIrradiance(base: Uint8Array[], size: number, outSize: number): Uint8Array[] {
    const faces: Uint8Array[] = [];
    const samples = 128;
    for (let face = 0; face < FACE_COUNT; face++) {
        const out = new Uint8Array(outSize * outSize * 4);
        for (let y = 0; y < outSize; y++) {
            for (let x = 0; x < outSize; x++) {
                const u = ((x + 0.5) / outSize) * 2 - 1;
                const v = ((y + 0.5) / outSize) * 2 - 1;
                const normal = normalize(faceDirection(face, u, v));
                const tangent = normalize(Math.abs(normal[1]) < 0.999 ? cross([0, 1, 0], normal) : cross([1, 0, 0], normal));
                const bitangent = cross(normal, tangent);
                let r = 0, g = 0, b = 0;
                for (let i = 0; i < samples; i++) {
                    const h = hammersley(i, samples);
                    const phi = Math.PI * 2 * h[0];
                    const cosTheta = Math.sqrt(1 - h[1]);
                    const sinTheta = Math.sqrt(h[1]);
                    const lx = Math.cos(phi) * sinTheta;
                    const ly = Math.sin(phi) * sinTheta;
                    const lz = cosTheta;
                    const dir = [
                        tangent[0] * lx + bitangent[0] * ly + normal[0] * lz,
                        tangent[1] * lx + bitangent[1] * ly + normal[1] * lz,
                        tangent[2] * lx + bitangent[2] * ly + normal[2] * lz,
                    ];
                    const c = sampleCube(base, size, dir);
                    r += c[0];
                    g += c[1];
                    b += c[2];
                }
                const o = (y * outSize + x) * 4;
                out[o] = Math.round(r / samples);
                out[o + 1] = Math.round(g / samples);
                out[o + 2] = Math.round(b / samples);
                out[o + 3] = 255;
            }
        }
        faces.push(out);
    }
    return faces;
}

function sampleEquirect(source: Pixels, x: number, y: number): [number, number, number] {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const x1 = (x0 + 1) % source.width;
    const y1 = Math.min(source.height - 1, Math.max(0, y0 + 1));
    const xa = ((x0 % source.width) + source.width) % source.width;
    const ya = Math.min(source.height - 1, Math.max(0, y0));
    const c00 = pixel(source, xa, ya);
    const c10 = pixel(source, x1, ya);
    const c01 = pixel(source, xa, y1);
    const c11 = pixel(source, x1, y1);
    return [
        lerp(lerp(c00[0], c10[0], fx), lerp(c01[0], c11[0], fx), fy),
        lerp(lerp(c00[1], c10[1], fx), lerp(c01[1], c11[1], fx), fy),
        lerp(lerp(c00[2], c10[2], fx), lerp(c01[2], c11[2], fx), fy),
    ];
}

function pixel(source: Pixels, x: number, y: number): [number, number, number] {
    const i = (y * source.width + x) * 4;
    return [
        srgbToLinear(source.data[i]! / 255) * 255,
        srgbToLinear(source.data[i + 1]! / 255) * 255,
        srgbToLinear(source.data[i + 2]! / 255) * 255,
    ];
}

/** Sample the base cubemap in linear space with bilinear filtering. */
function sampleCube(faces: Uint8Array[], size: number, dir: number[]): [number, number, number] {
    const [face, u, v] = cubeFaceUV(dir);
    const x = (u + 1) * 0.5 * size - 0.5;
    const y = (v + 1) * 0.5 * size - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const input = faces[face]!;
    const texel = (tx: number, ty: number): [number, number, number] => {
        const cx = Math.min(size - 1, Math.max(0, tx));
        const cy = Math.min(size - 1, Math.max(0, ty));
        const i = (cy * size + cx) * 4;
        return [input[i]!, input[i + 1]!, input[i + 2]!];
    };
    const c00 = texel(x0, y0);
    const c10 = texel(x0 + 1, y0);
    const c01 = texel(x0, y0 + 1);
    const c11 = texel(x0 + 1, y0 + 1);
    return [
        lerp(lerp(c00[0], c10[0], fx), lerp(c01[0], c11[0], fx), fy),
        lerp(lerp(c00[1], c10[1], fx), lerp(c01[1], c11[1], fx), fy),
        lerp(lerp(c00[2], c10[2], fx), lerp(c01[2], c11[2], fx), fy),
    ];
}

function faceDirection(face: number, u: number, v: number): [number, number, number] {
    switch (face) {
        case 0: return [1, -v, -u];
        case 1: return [-1, -v, u];
        case 2: return [u, 1, v];
        case 3: return [u, -1, -v];
        case 4: return [u, -v, 1];
        default: return [-u, -v, -1];
    }
}

function cubeFaceUV(dir: number[]): [number, number, number] {
    const ax = Math.abs(dir[0]!), ay = Math.abs(dir[1]!), az = Math.abs(dir[2]!);
    if (ax >= ay && ax >= az) {
        return dir[0]! >= 0
            ? [0, -dir[2]! / ax, -dir[1]! / ax]
            : [1, dir[2]! / ax, -dir[1]! / ax];
    }
    if (ay >= az) {
        return dir[1]! >= 0
            ? [2, dir[0]! / ay, dir[2]! / ay]
            : [3, dir[0]! / ay, -dir[2]! / ay];
    }
    return dir[2]! >= 0
        ? [4, dir[0]! / az, -dir[1]! / az]
        : [5, -dir[0]! / az, -dir[1]! / az];
}

function hammersley(i: number, n: number): [number, number] {
    return [i / n, radicalInverse(i)];
}

function radicalInverse(bits: number): number {
    let v = bits;
    let result = 0;
    let scale = 0.5;
    while (v > 0) {
        result += (v & 1) * scale;
        v >>>= 1;
        scale *= 0.5;
    }
    return result;
}

function srgbToLinear(v: number): number {
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function normalize(v: number[]): [number, number, number] {
    const len = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
    return [v[0]! / len, v[1]! / len, v[2]! / len];
}

function cross(a: number[], b: number[]): [number, number, number] {
    return [
        a[1]! * b[2]! - a[2]! * b[1]!,
        a[2]! * b[0]! - a[0]! * b[2]!,
        a[0]! * b[1]! - a[1]! * b[0]!,
    ];
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}
