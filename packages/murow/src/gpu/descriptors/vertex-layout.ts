/**
 * Vertex buffer layouts as plain data.
 *
 * A layout pairs a stride and step mode with an ordered list of attributes.
 * Formats are backend-agnostic strings such as `'float32x3'`; each backend
 * maps them to its API. Offsets are byte offsets into one vertex element.
 */

/** Per-vertex or per-instance stepping. */
export type VertexStepMode = 'vertex' | 'instance';

/**
 * Vertex attribute format. The known formats below are WebGPU-compatible
 * strings; any backend-specific format is also accepted.
 */
export type VertexFormat =
    | 'float32'
    | 'float32x2'
    | 'float32x3'
    | 'float32x4'
    | 'sint32'
    | 'sint32x2'
    | 'sint32x3'
    | 'sint32x4'
    | 'uint32'
    | 'uint32x2'
    | 'uint32x3'
    | 'uint32x4'
    | 'sint16x2'
    | 'sint16x4'
    | 'uint16x2'
    | 'uint16x4'
    | 'sint8x2'
    | 'sint8x4'
    | 'uint8x2'
    | 'uint8x4'
    | 'unorm8x2'
    | 'unorm8x4'
    | 'snorm8x2'
    | 'snorm8x4'
    | 'unorm16x2'
    | 'unorm16x4'
    | 'snorm16x2'
    | 'snorm16x4'
    | 'float16x2'
    | 'float16x4'
    | 'unorm10-10-10-2'
    | (string & {});

/** Byte size of a known vertex format. */
export const VERTEX_FORMAT_SIZES: Readonly<Record<string, number>> = Object.freeze({
    float32: 4,
    float32x2: 8,
    float32x3: 12,
    float32x4: 16,
    sint32: 4,
    sint32x2: 8,
    sint32x3: 12,
    sint32x4: 16,
    uint32: 4,
    uint32x2: 8,
    uint32x3: 12,
    uint32x4: 16,
    sint16x2: 4,
    sint16x4: 8,
    uint16x2: 4,
    uint16x4: 8,
    sint8x2: 2,
    sint8x4: 4,
    uint8x2: 2,
    uint8x4: 4,
    unorm8x2: 2,
    unorm8x4: 4,
    snorm8x2: 2,
    snorm8x4: 4,
    unorm16x2: 4,
    unorm16x4: 8,
    snorm16x2: 4,
    snorm16x4: 8,
    float16x2: 4,
    float16x4: 8,
    'unorm10-10-10-2': 4,
});

/** One vertex attribute: shader location, format, and byte offset. */
export interface VertexAttribute {
    readonly location: number;
    readonly format: VertexFormat;
    readonly offset: number;
}

function vertexFormatSize(format: VertexFormat): number {
    const size = (VERTEX_FORMAT_SIZES as Record<string, number>)[format];
    if (size === undefined) throw new Error(`Unknown vertex format '${format}'`);
    return size;
}

/** Byte size of a vertex format. Throws for unknown formats. */
export function formatSize(format: VertexFormat): number {
    return vertexFormatSize(format);
}

/** Byte offsets that pack the formats back to back, starting at zero. */
export function computeTightOffsets(formats: readonly VertexFormat[]): number[] {
    const offsets: number[] = [];
    let offset = 0;
    for (const format of formats) {
        offsets.push(offset);
        offset += vertexFormatSize(format);
    }
    return offsets;
}

/** Total byte size of a tight packing of the formats. */
export function tightStride(formats: readonly VertexFormat[]): number {
    let stride = 0;
    for (const format of formats) stride += vertexFormatSize(format);
    return stride;
}

/** Options for {@link VertexBufferLayout}. */
export interface VertexBufferLayoutOptions {
    /** Stride in bytes. Defaults to the tight size of the attributes. */
    readonly stride?: number;
    /** Default `'vertex'`. */
    readonly stepMode?: VertexStepMode;
    readonly attributes: readonly VertexAttribute[];
}

/**
 * A vertex buffer layout. Attributes are validated on construction:
 * unique locations, known formats, and offsets inside the stride.
 */
export class VertexBufferLayout {
    readonly stride: number;
    readonly stepMode: VertexStepMode;
    readonly attributes: readonly VertexAttribute[];

    constructor(options: VertexBufferLayoutOptions) {
        const attributes = options.attributes ?? [];
        this.stepMode = options.stepMode ?? 'vertex';
        this.stride = options.stride ?? tightAttributeSize(attributes);
        this.attributes = attributes;
        validateVertexBufferLayout(this);
    }
}

/** Build attributes with tight offsets, then wrap them in a layout. */
export class VertexLayoutBuilder {
    private readonly formats: VertexFormat[] = [];
    private mode: VertexStepMode = 'vertex';
    private strideValue: number | undefined;
    private firstLocation = 0;

    /** Append an attribute using its position in the list as the location. */
    attribute(format: VertexFormat, location?: number): this {
        this.formats.push(format);
        if (location !== undefined) this.firstLocation = Math.min(this.firstLocation, location);
        return this;
    }

    /** Locations are assigned from this value upward when not given. */
    startingLocation(location: number): this {
        this.firstLocation = location;
        return this;
    }

    stepMode(mode: VertexStepMode): this {
        this.mode = mode;
        return this;
    }

    /** Override the computed tight stride. */
    stride(bytes: number): this {
        this.strideValue = bytes;
        return this;
    }

    build(): VertexBufferLayout {
        const offsets = computeTightOffsets(this.formats);
        const attributes: VertexAttribute[] = this.formats.map((format, i) => ({
            location: this.firstLocation + i,
            format,
            offset: offsets[i],
        }));
        return new VertexBufferLayout({
            stride: this.strideValue,
            stepMode: this.mode,
            attributes,
        });
    }
}

/** Throw when a layout is malformed. */
export function validateVertexBufferLayout(layout: VertexBufferLayout): void {
    const seen = new Set<number>();
    for (const attribute of layout.attributes) {
        if (seen.has(attribute.location)) {
            throw new Error(`VertexBufferLayout: duplicate attribute location ${attribute.location}`);
        }
        seen.add(attribute.location);
        if (attribute.offset < 0) {
            throw new Error(`VertexBufferLayout: negative offset for location ${attribute.location}`);
        }
        const end = attribute.offset + vertexFormatSize(attribute.format);
        if (end > layout.stride) {
            throw new Error(
                `VertexBufferLayout: attribute at location ${attribute.location} overruns stride ${layout.stride}`,
            );
        }
    }
}

function tightAttributeSize(attributes: readonly VertexAttribute[]): number {
    let size = 0;
    for (const attribute of attributes) {
        size = Math.max(size, attribute.offset + vertexFormatSize(attribute.format));
    }
    return size;
}
