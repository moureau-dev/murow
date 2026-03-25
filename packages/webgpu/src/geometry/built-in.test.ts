import { test, expect, describe } from 'bun:test';
import {
    createQuad,
    createTriangle,
    createLine,
    createPoint,
    createCircle,
    createCube,
    createSphere,
    createCylinder,
    createCone,
    resolveBuiltInGeometry,
} from './built-in';
import type { GeometryData } from './built-in';

function verifyGeometry(g: GeometryData) {
    expect(g.vertices).toBeInstanceOf(Float32Array);
    expect(g.vertices.length).toBe(g.vertexCount * g.floatsPerVertex);
    expect(g.vertexCount).toBeGreaterThan(0);
    expect(g.floatsPerVertex).toBeGreaterThan(0);
    expect(typeof g.is3D).toBe('boolean');
}

describe('createQuad', () => {
    test('returns valid geometry data', () => {
        verifyGeometry(createQuad());
    });

    test('has 6 vertices (two triangles)', () => {
        expect(createQuad().vertexCount).toBe(6);
    });

    test('has 4 floats per vertex (x, y, u, v)', () => {
        expect(createQuad().floatsPerVertex).toBe(4);
    });

    test('is 2D', () => {
        expect(createQuad().is3D).toBe(false);
    });

    test('vertex data length matches vertexCount * floatsPerVertex', () => {
        const q = createQuad();
        expect(q.vertices.length).toBe(24); // 6 * 4
    });

    test('positions are in [-1, 1] range', () => {
        const q = createQuad();
        for (let i = 0; i < q.vertexCount; i++) {
            const px = q.vertices[i * 4];
            const py = q.vertices[i * 4 + 1];
            expect(px).toBeGreaterThanOrEqual(-1);
            expect(px).toBeLessThanOrEqual(1);
            expect(py).toBeGreaterThanOrEqual(-1);
            expect(py).toBeLessThanOrEqual(1);
        }
    });

    test('UVs are in [0, 1] range', () => {
        const q = createQuad();
        for (let i = 0; i < q.vertexCount; i++) {
            const u = q.vertices[i * 4 + 2];
            const v = q.vertices[i * 4 + 3];
            expect(u).toBeGreaterThanOrEqual(0);
            expect(u).toBeLessThanOrEqual(1);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
        }
    });
});

describe('createTriangle', () => {
    test('returns valid geometry data', () => {
        verifyGeometry(createTriangle());
    });

    test('has 3 vertices', () => {
        expect(createTriangle().vertexCount).toBe(3);
    });

    test('has 4 floats per vertex', () => {
        expect(createTriangle().floatsPerVertex).toBe(4);
    });

    test('is 2D', () => {
        expect(createTriangle().is3D).toBe(false);
    });
});

describe('createLine', () => {
    test('returns valid geometry data', () => {
        verifyGeometry(createLine());
    });

    test('has 2 vertices', () => {
        expect(createLine().vertexCount).toBe(2);
    });

    test('has 4 floats per vertex', () => {
        expect(createLine().floatsPerVertex).toBe(4);
    });

    test('is 2D', () => {
        expect(createLine().is3D).toBe(false);
    });

    test('endpoints are at -1 and 1 on x axis', () => {
        const l = createLine();
        expect(l.vertices[0]).toBe(-1); // first vertex x
        expect(l.vertices[4]).toBe(1);  // second vertex x
    });
});

describe('createPoint', () => {
    test('returns valid geometry data', () => {
        verifyGeometry(createPoint());
    });

    test('has 1 vertex', () => {
        expect(createPoint().vertexCount).toBe(1);
    });

    test('has 4 floats per vertex', () => {
        expect(createPoint().floatsPerVertex).toBe(4);
    });

    test('is 2D', () => {
        expect(createPoint().is3D).toBe(false);
    });

    test('position is at origin', () => {
        const p = createPoint();
        expect(p.vertices[0]).toBe(0);
        expect(p.vertices[1]).toBe(0);
    });

    test('UV is at center (0.5, 0.5)', () => {
        const p = createPoint();
        expect(p.vertices[2]).toBe(0.5);
        expect(p.vertices[3]).toBe(0.5);
    });
});

describe('createCircle', () => {
    test('returns valid geometry data with default segments', () => {
        verifyGeometry(createCircle());
    });

    test('default has 32 segments => 96 vertices', () => {
        expect(createCircle().vertexCount).toBe(96); // 32 * 3
    });

    test('custom segment count', () => {
        expect(createCircle(8).vertexCount).toBe(24);  // 8 * 3
        expect(createCircle(64).vertexCount).toBe(192); // 64 * 3
    });

    test('has 4 floats per vertex', () => {
        expect(createCircle().floatsPerVertex).toBe(4);
    });

    test('is 2D', () => {
        expect(createCircle().is3D).toBe(false);
    });

    test('center vertices are at origin', () => {
        const c = createCircle(4);
        // Every 3 vertices: first is center (0, 0, 0.5, 0.5)
        for (let i = 0; i < 4; i++) {
            const base = i * 3 * 4; // segment * 3 verts * 4 floats
            expect(c.vertices[base]).toBe(0);
            expect(c.vertices[base + 1]).toBe(0);
        }
    });

    test('edge vertices are at unit distance from origin', () => {
        const c = createCircle(8);
        for (let i = 0; i < 8; i++) {
            // Second vertex of each triangle (edge vertex 1)
            const base = (i * 3 + 1) * 4;
            const x = c.vertices[base];
            const y = c.vertices[base + 1];
            const dist = Math.sqrt(x * x + y * y);
            expect(dist).toBeCloseTo(1, 5);
        }
    });
});

describe('createCube', () => {
    test('returns valid geometry data', () => {
        verifyGeometry(createCube());
    });

    test('has 36 vertices (6 faces * 2 triangles * 3 vertices)', () => {
        expect(createCube().vertexCount).toBe(36);
    });

    test('has 8 floats per vertex (pos.xyz + normal.xyz + uv)', () => {
        expect(createCube().floatsPerVertex).toBe(8);
    });

    test('is 3D', () => {
        expect(createCube().is3D).toBe(true);
    });

    test('vertex data length is 288 (36 * 8)', () => {
        expect(createCube().vertices.length).toBe(288);
    });

    test('normals are unit length', () => {
        const c = createCube();
        for (let i = 0; i < c.vertexCount; i++) {
            const nx = c.vertices[i * 8 + 3];
            const ny = c.vertices[i * 8 + 4];
            const nz = c.vertices[i * 8 + 5];
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            expect(len).toBeCloseTo(1, 5);
        }
    });
});

describe('createSphere', () => {
    test('returns valid geometry data with defaults', () => {
        verifyGeometry(createSphere());
    });

    test('default has 16*32*6 = 3072 vertices', () => {
        expect(createSphere().vertexCount).toBe(3072);
    });

    test('custom segment counts', () => {
        expect(createSphere(4, 8).vertexCount).toBe(4 * 8 * 6);
    });

    test('has 8 floats per vertex', () => {
        expect(createSphere().floatsPerVertex).toBe(8);
    });

    test('is 3D', () => {
        expect(createSphere().is3D).toBe(true);
    });

    test('positions are approximately unit sphere', () => {
        const s = createSphere(4, 4);
        for (let i = 0; i < s.vertexCount; i++) {
            const x = s.vertices[i * 8];
            const y = s.vertices[i * 8 + 1];
            const z = s.vertices[i * 8 + 2];
            const dist = Math.sqrt(x * x + y * y + z * z);
            expect(dist).toBeCloseTo(1, 3);
        }
    });
});

describe('createCylinder', () => {
    test('returns valid geometry data with defaults', () => {
        verifyGeometry(createCylinder());
    });

    test('default has 32*12 = 384 vertices', () => {
        // 32 segments * (6 side + 3 top cap + 3 bottom cap) = 32 * 12
        expect(createCylinder().vertexCount).toBe(384);
    });

    test('custom segment count', () => {
        expect(createCylinder(8).vertexCount).toBe(96); // 8 * 12
    });

    test('has 8 floats per vertex', () => {
        expect(createCylinder().floatsPerVertex).toBe(8);
    });

    test('is 3D', () => {
        expect(createCylinder().is3D).toBe(true);
    });
});

describe('createCone', () => {
    test('returns valid geometry data with defaults', () => {
        verifyGeometry(createCone());
    });

    test('default has 32*6 = 192 vertices', () => {
        expect(createCone().vertexCount).toBe(192);
    });

    test('custom segment count', () => {
        expect(createCone(16).vertexCount).toBe(96); // 16 * 6
    });

    test('has 8 floats per vertex', () => {
        expect(createCone().floatsPerVertex).toBe(8);
    });

    test('is 3D', () => {
        expect(createCone().is3D).toBe(true);
    });

    test('tip vertex is at (0, 1, 0)', () => {
        const c = createCone(4);
        // First vertex of each side triangle is the tip
        for (let i = 0; i < 4; i++) {
            const base = i * 6 * 8; // segment * 6 verts * 8 floats
            expect(c.vertices[base]).toBe(0);
            expect(c.vertices[base + 1]).toBe(1);
            expect(c.vertices[base + 2]).toBe(0);
        }
    });
});

describe('resolveBuiltInGeometry', () => {
    const names = ['quad', 'triangle', 'line', 'point', 'circle', 'cube', 'sphere', 'cylinder', 'cone'] as const;

    for (const name of names) {
        test(`resolves "${name}" to valid geometry`, () => {
            const g = resolveBuiltInGeometry(name);
            verifyGeometry(g);
        });
    }

    test('2D geometries have is3D=false', () => {
        for (const name of ['quad', 'triangle', 'line', 'point', 'circle'] as const) {
            expect(resolveBuiltInGeometry(name).is3D).toBe(false);
        }
    });

    test('3D geometries have is3D=true', () => {
        for (const name of ['cube', 'sphere', 'cylinder', 'cone'] as const) {
            expect(resolveBuiltInGeometry(name).is3D).toBe(true);
        }
    });

    test('2D geometries have floatsPerVertex=4', () => {
        for (const name of ['quad', 'triangle', 'line', 'point', 'circle'] as const) {
            expect(resolveBuiltInGeometry(name).floatsPerVertex).toBe(4);
        }
    });

    test('3D geometries have floatsPerVertex=8', () => {
        for (const name of ['cube', 'sphere', 'cylinder', 'cone'] as const) {
            expect(resolveBuiltInGeometry(name).floatsPerVertex).toBe(8);
        }
    });
});
