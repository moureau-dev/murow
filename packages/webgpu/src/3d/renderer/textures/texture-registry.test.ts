import { test, expect, describe } from 'bun:test';
import { TextureRegistry } from './texture-registry';

// Browser global, absent in bun's test runtime.
Object.assign(globalThis, { GPUTextureUsage: { TEXTURE_BINDING: 1, COPY_DST: 2 } });

function mockDevice() {
    const created: string[] = [];
    const device = {
        createTexture: () => ({ createView: () => ({ __view: true }) }),
        createSampler: () => ({ __sampler: true }),
        createBindGroup: () => ({ __bindGroup: true }),
        queue: { writeTexture: () => {} },
    } as unknown as GPUDevice;
    return { device, created };
}

describe('TextureRegistry', () => {
    test('missing ids are absent until uploaded', () => {
        const { device } = mockDevice();
        const reg = new TextureRegistry(device, {} as GPUBindGroupLayout);
        expect(reg.has('brick')).toBe(false);
        expect(reg.get('brick')).toBeUndefined();
    });

    test('white fallback registers under the empty id', () => {
        const { device } = mockDevice();
        const reg = new TextureRegistry(device, {} as GPUBindGroupLayout);
        reg.initWhiteFallback();
        expect(reg.has('')).toBe(true);
        expect(reg.get('')!.bindGroup).toBeDefined();
        expect(reg.white).toBe(reg.get('')!.bindGroup);
    });
});
