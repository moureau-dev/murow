/**
 * Built-in geometry primitives.
 * Each returns a typed array of vertex data and optional indices.
 */

export type BuiltInGeometry =
    | 'quad'
    | 'triangle'
    | 'line'
    | 'point'
    | 'circle'
    | 'cube'
    | 'sphere'
    | 'cylinder'
    | 'cone';

export interface GeometryData {
    /** Interleaved vertex data: [posX, posY, (posZ,) u, v, ...] */
    vertices: Float32Array;
    /** Optional index buffer */
    indices?: Uint16Array | Uint32Array;
    /** Number of vertices */
    vertexCount: number;
    /** Floats per vertex (stride) */
    floatsPerVertex: number;
    /** Whether this is a 3D geometry */
    is3D: boolean;
}

/**
 * 2D quad: 6 vertices (two triangles), each with position (x,y) + uv (u,v).
 * Position range: [-1, 1], UV range: [0, 1].
 */
export function createQuad(): GeometryData {
    // prettier-ignore
    const vertices = new Float32Array([
        // pos.x, pos.y, u, v
        -1, -1,  0, 1,  // bottom-left
         1, -1,  1, 1,  // bottom-right
         1,  1,  1, 0,  // top-right

        -1, -1,  0, 1,  // bottom-left
         1,  1,  1, 0,  // top-right
        -1,  1,  0, 0,  // top-left
    ]);

    return { vertices, vertexCount: 6, floatsPerVertex: 4, is3D: false };
}

/**
 * 2D triangle: 3 vertices, each with position (x,y) + uv (u,v).
 */
export function createTriangle(): GeometryData {
    // prettier-ignore
    const vertices = new Float32Array([
         0,  1,  0.5, 0,   // top
        -1, -1,  0,   1,   // bottom-left
         1, -1,  1,   1,   // bottom-right
    ]);

    return { vertices, vertexCount: 3, floatsPerVertex: 4, is3D: false };
}

/**
 * 2D line: 2 vertices, position only.
 */
export function createLine(): GeometryData {
    const vertices = new Float32Array([
        -1, 0,  0, 0.5,
         1, 0,  1, 0.5,
    ]);

    return { vertices, vertexCount: 2, floatsPerVertex: 4, is3D: false };
}

/**
 * 2D point: single vertex at origin.
 */
export function createPoint(): GeometryData {
    const vertices = new Float32Array([0, 0, 0.5, 0.5]);
    return { vertices, vertexCount: 1, floatsPerVertex: 4, is3D: false };
}

/**
 * 2D circle: tessellated triangle fan, configurable segments.
 */
export function createCircle(segments: number = 32): GeometryData {
    const verts: number[] = [];
    const step = (Math.PI * 2) / segments;

    for (let i = 0; i < segments; i++) {
        const a0 = i * step;
        const a1 = (i + 1) * step;

        // center
        verts.push(0, 0, 0.5, 0.5);
        // edge vertex 1
        verts.push(Math.cos(a0), Math.sin(a0), Math.cos(a0) * 0.5 + 0.5, Math.sin(a0) * 0.5 + 0.5);
        // edge vertex 2
        verts.push(Math.cos(a1), Math.sin(a1), Math.cos(a1) * 0.5 + 0.5, Math.sin(a1) * 0.5 + 0.5);
    }

    return {
        vertices: new Float32Array(verts),
        vertexCount: segments * 3,
        floatsPerVertex: 4,
        is3D: false,
    };
}

/**
 * 3D cube: 36 vertices with position (x,y,z) + normal (nx,ny,nz) + uv (u,v).
 */
export function createCube(): GeometryData {
    // prettier-ignore
    const vertices = new Float32Array([
        // Front face
        -1, -1,  1,  0, 0, 1,  0, 1,
         1, -1,  1,  0, 0, 1,  1, 1,
         1,  1,  1,  0, 0, 1,  1, 0,
        -1, -1,  1,  0, 0, 1,  0, 1,
         1,  1,  1,  0, 0, 1,  1, 0,
        -1,  1,  1,  0, 0, 1,  0, 0,
        // Back face
         1, -1, -1,  0, 0,-1,  0, 1,
        -1, -1, -1,  0, 0,-1,  1, 1,
        -1,  1, -1,  0, 0,-1,  1, 0,
         1, -1, -1,  0, 0,-1,  0, 1,
        -1,  1, -1,  0, 0,-1,  1, 0,
         1,  1, -1,  0, 0,-1,  0, 0,
        // Top face
        -1,  1,  1,  0, 1, 0,  0, 1,
         1,  1,  1,  0, 1, 0,  1, 1,
         1,  1, -1,  0, 1, 0,  1, 0,
        -1,  1,  1,  0, 1, 0,  0, 1,
         1,  1, -1,  0, 1, 0,  1, 0,
        -1,  1, -1,  0, 1, 0,  0, 0,
        // Bottom face
        -1, -1, -1,  0,-1, 0,  0, 1,
         1, -1, -1,  0,-1, 0,  1, 1,
         1, -1,  1,  0,-1, 0,  1, 0,
        -1, -1, -1,  0,-1, 0,  0, 1,
         1, -1,  1,  0,-1, 0,  1, 0,
        -1, -1,  1,  0,-1, 0,  0, 0,
        // Right face
         1, -1,  1,  1, 0, 0,  0, 1,
         1, -1, -1,  1, 0, 0,  1, 1,
         1,  1, -1,  1, 0, 0,  1, 0,
         1, -1,  1,  1, 0, 0,  0, 1,
         1,  1, -1,  1, 0, 0,  1, 0,
         1,  1,  1,  1, 0, 0,  0, 0,
        // Left face
        -1, -1, -1, -1, 0, 0,  0, 1,
        -1, -1,  1, -1, 0, 0,  1, 1,
        -1,  1,  1, -1, 0, 0,  1, 0,
        -1, -1, -1, -1, 0, 0,  0, 1,
        -1,  1,  1, -1, 0, 0,  1, 0,
        -1,  1, -1, -1, 0, 0,  0, 0,
    ]);

    return { vertices, vertexCount: 36, floatsPerVertex: 8, is3D: true };
}

/**
 * 3D sphere: tessellated with position + normal + uv.
 */
export function createSphere(latSegments: number = 16, lonSegments: number = 32): GeometryData {
    const verts: number[] = [];

    for (let lat = 0; lat < latSegments; lat++) {
        const theta0 = (lat / latSegments) * Math.PI;
        const theta1 = ((lat + 1) / latSegments) * Math.PI;

        for (let lon = 0; lon < lonSegments; lon++) {
            const phi0 = (lon / lonSegments) * Math.PI * 2;
            const phi1 = ((lon + 1) / lonSegments) * Math.PI * 2;

            const p00 = spherePoint(theta0, phi0);
            const p10 = spherePoint(theta1, phi0);
            const p01 = spherePoint(theta0, phi1);
            const p11 = spherePoint(theta1, phi1);

            const u0 = lon / lonSegments;
            const u1 = (lon + 1) / lonSegments;
            const v0 = lat / latSegments;
            const v1 = (lat + 1) / latSegments;

            // Triangle 1
            verts.push(...p00, ...p00, u0, v0);
            verts.push(...p10, ...p10, u0, v1);
            verts.push(...p11, ...p11, u1, v1);

            // Triangle 2
            verts.push(...p00, ...p00, u0, v0);
            verts.push(...p11, ...p11, u1, v1);
            verts.push(...p01, ...p01, u1, v0);
        }
    }

    return {
        vertices: new Float32Array(verts),
        vertexCount: latSegments * lonSegments * 6,
        floatsPerVertex: 8,
        is3D: true,
    };
}

function spherePoint(theta: number, phi: number): [number, number, number] {
    return [
        Math.sin(theta) * Math.cos(phi),
        Math.cos(theta),
        Math.sin(theta) * Math.sin(phi),
    ];
}

/**
 * 3D cylinder: tessellated with position + normal + uv.
 */
export function createCylinder(segments: number = 32): GeometryData {
    const verts: number[] = [];
    const step = (Math.PI * 2) / segments;

    for (let i = 0; i < segments; i++) {
        const a0 = i * step;
        const a1 = (i + 1) * step;
        const c0 = Math.cos(a0), s0 = Math.sin(a0);
        const c1 = Math.cos(a1), s1 = Math.sin(a1);
        const u0 = i / segments;
        const u1 = (i + 1) / segments;

        // Side faces
        verts.push(c0, -1, s0, c0, 0, s0, u0, 1);
        verts.push(c1, -1, s1, c1, 0, s1, u1, 1);
        verts.push(c1,  1, s1, c1, 0, s1, u1, 0);

        verts.push(c0, -1, s0, c0, 0, s0, u0, 1);
        verts.push(c1,  1, s1, c1, 0, s1, u1, 0);
        verts.push(c0,  1, s0, c0, 0, s0, u0, 0);

        // Top cap
        verts.push(0, 1, 0, 0, 1, 0, 0.5, 0.5);
        verts.push(c0, 1, s0, 0, 1, 0, c0 * 0.5 + 0.5, s0 * 0.5 + 0.5);
        verts.push(c1, 1, s1, 0, 1, 0, c1 * 0.5 + 0.5, s1 * 0.5 + 0.5);

        // Bottom cap
        verts.push(0, -1, 0, 0, -1, 0, 0.5, 0.5);
        verts.push(c1, -1, s1, 0, -1, 0, c1 * 0.5 + 0.5, s1 * 0.5 + 0.5);
        verts.push(c0, -1, s0, 0, -1, 0, c0 * 0.5 + 0.5, s0 * 0.5 + 0.5);
    }

    return {
        vertices: new Float32Array(verts),
        vertexCount: segments * 12,
        floatsPerVertex: 8,
        is3D: true,
    };
}

/**
 * 3D cone: tessellated with position + normal + uv.
 */
export function createCone(segments: number = 32): GeometryData {
    const verts: number[] = [];
    const step = (Math.PI * 2) / segments;

    for (let i = 0; i < segments; i++) {
        const a0 = i * step;
        const a1 = (i + 1) * step;
        const c0 = Math.cos(a0), s0 = Math.sin(a0);
        const c1 = Math.cos(a1), s1 = Math.sin(a1);

        // Side face (tip at y=1, base at y=-1)
        // Approximate normals: average of face normal
        const nx = (c0 + c1) * 0.5;
        const nz = (s0 + s1) * 0.5;
        const ny = 0.5;
        const nLen = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);

        verts.push(0, 1, 0, nx * nLen, ny * nLen, nz * nLen, 0.5, 0);
        verts.push(c0, -1, s0, nx * nLen, ny * nLen, nz * nLen, i / segments, 1);
        verts.push(c1, -1, s1, nx * nLen, ny * nLen, nz * nLen, (i + 1) / segments, 1);

        // Bottom cap
        verts.push(0, -1, 0, 0, -1, 0, 0.5, 0.5);
        verts.push(c1, -1, s1, 0, -1, 0, c1 * 0.5 + 0.5, s1 * 0.5 + 0.5);
        verts.push(c0, -1, s0, 0, -1, 0, c0 * 0.5 + 0.5, s0 * 0.5 + 0.5);
    }

    return {
        vertices: new Float32Array(verts),
        vertexCount: segments * 6,
        floatsPerVertex: 8,
        is3D: true,
    };
}

/**
 * Resolve a built-in geometry name to actual data.
 */
export function resolveBuiltInGeometry(name: BuiltInGeometry): GeometryData {
    switch (name) {
        case 'quad': return createQuad();
        case 'triangle': return createTriangle();
        case 'line': return createLine();
        case 'point': return createPoint();
        case 'circle': return createCircle();
        case 'cube': return createCube();
        case 'sphere': return createSphere();
        case 'cylinder': return createCylinder();
        case 'cone': return createCone();
    }
}
