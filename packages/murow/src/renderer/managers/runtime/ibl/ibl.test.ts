import { describe, expect, test } from 'bun:test';
import type { RawDevice } from 'murow/gpu';
import { IblManager } from './ibl';

function fakeDevice() {
    const textures: { writes: { mipLevel: number; origin: number[]; size: number[] }[] }[] = [];
    const uniforms: Float32Array[] = [];
    const device = {
        createTexture() {
            const record = { writes: [] as { mipLevel: number; origin: number[]; size: number[] }[] };
            textures.push(record);
            return {
                createView: () => ({}),
                destroy() { /* no-op */ },
                record,
            };
        },
        createSampler: () => ({}),
        createBuffer: () => ({}),
        queue: {
            writeBuffer: (_buffer: unknown, _offset: number, data: Float32Array) => {
                uniforms.push(new Float32Array(data));
            },
            writeTexture: (destination: { texture: { record: { writes: { mipLevel: number; origin: number[]; size: number[] }[] } }; mipLevel: number; origin: number[] }, _data: unknown, _layout: unknown, size: number[]) => {
                destination.texture.record.writes.push({ mipLevel: destination.mipLevel, origin: [...destination.origin], size: [...size] });
            },
        },
    };
    return { device: device as unknown as RawDevice, textures, uniforms };
}

const pixels = (width: number, height: number) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
        data[i] = 160;
        data[i + 1] = 200;
        data[i + 2] = 255;
        data[i + 3] = 255;
    }
    return { data, width, height };
};

describe('IblManager', () => {
    test('starts disabled with zeroed cubemaps', () => {
        const { device, uniforms } = fakeDevice();
        new IblManager(device);
        expect(uniforms.length).toBeGreaterThan(0);
        expect(uniforms[0]![3]).toBe(0);
    });

    test('loads an equirect environment into a mip chain', async () => {
        const { device, textures, uniforms } = fakeDevice();
        const ibl = new IblManager(device);
        const before = textures.map((t) => t.writes.length);
        await ibl.load({ equirect: pixels(64, 32), intensity: 1.4, rotation: 0.5 });

        expect(ibl.active).toBe(true);
        expect(ibl.intensity).toBeCloseTo(1.4);
        expect(ibl.rotation).toBeCloseTo(0.5);
        expect(textures[0]!.writes.length).toBeGreaterThan(before[0]!);
        expect(textures[1]!.writes.length).toBeGreaterThan(before[1]!);
        const last = uniforms[uniforms.length - 1]!;
        expect(last[1]).toBeCloseTo(0.5);
        expect(last[2]).toBe(6);
        expect(last[3]).toBe(1);
    });

    test('set updates intensity and rotation with one uniform upload', async () => {
        const { device, uniforms } = fakeDevice();
        const ibl = new IblManager(device);
        const before = uniforms.length;
        ibl.set({ intensity: 2.2, rotation: 1.1 });
        expect(uniforms.length).toBe(before + 1);
        expect(uniforms[uniforms.length - 1]![0]).toBeCloseTo(2.2);
        expect(uniforms[uniforms.length - 1]![1]).toBeCloseTo(1.1);
    });

    test('skybox resolution is configurable and bumps the equirect version', async () => {
        const { device } = fakeDevice();
        const ibl = new IblManager(device);
        const before = ibl.equirectVersion;
        ibl.skyboxResolution = 256;
        expect(ibl.skyboxResolution).toBe(256);
        expect(ibl.equirectVersion).toBeGreaterThan(before);
    });

    test('load accepts a skybox resolution', async () => {
        const { device } = fakeDevice();
        const ibl = new IblManager(device);
        await ibl.load({ equirect: pixels(64, 32), skyboxResolution: 384 });
        expect(ibl.skyboxResolution).toBe(384);
    });

    test('clear disables the environment', async () => {
        const { device, uniforms } = fakeDevice();
        const ibl = new IblManager(device);
        await ibl.load({ equirect: pixels(32, 16) });
        ibl.clear();
        expect(ibl.active).toBe(false);
        expect(uniforms[uniforms.length - 1]![3]).toBe(0);
    });
});
