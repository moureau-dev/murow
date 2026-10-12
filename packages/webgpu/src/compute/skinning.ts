/**
 * WebGPU implementation of the renderer's `Skinning` port.
 *
 * Wraps the skeletal-animation compute kernel so the renderer never sees a
 * kernel or a builder. A non-compute backend would implement the same port
 * with a CPU or vertex path.
 */
import type { AnimationKernelBudgets, PackedAnimationBuffers, Skinning } from 'murow/renderer/managers/runtime';
import { buildAnimationKernel, uploadPackedToKernel } from './skeletal-animation/kernel';
import { packAnimationData, type PackedBuffers } from './skeletal-animation/packer';

function toPortBuffers(pb: PackedBuffers): PackedAnimationBuffers {
    return {
        clipTableOffset: pb.clipTableOffset,
        channelTableOffset: pb.channelTableOffset,
        jointLookupOffset: pb.jointLookupOffset,
        skelI32Length: pb.skelI32.length,
        animF32Length: pb.animF32.length,
        totalMats: pb.totalMats,
    };
}

/** Build a `Skinning` port backed by the WebGPU compute kernel. */
export function createComputeSkinning(): Skinning {
    let kernel: any = null;
    let root: any = null;

    return {
        pack: (packed) => toPortBuffers(packAnimationData(packed as never)),

        build: (r, packed, maxInstances, maxTotalBones, budgets: AnimationKernelBudgets) => {
            root = r;
            kernel?.destroy();
            const built = buildAnimationKernel(r as never, packed as never, maxInstances, maxTotalBones, budgets);
            kernel = built.kernel;
            return { buffers: toPortBuffers(built.packedBuffers), budgets: built.budgets };
        },

        upload: (r, packed) => {
            root = r;
            uploadPackedToKernel(r as never, kernel, packAnimationData(packed as never));
        },

        step: (count, instData, buffers) => {
            kernel.write('uniforms', {
                instanceCount: count,
                clipTableOffset: buffers.clipTableOffset,
                channelTableOffset: buffers.channelTableOffset,
                jointLookupOffset: buffers.jointLookupOffset,
            });
            const instBuf = kernel.getBuffer('instances');
            root.device.queue.writeBuffer(instBuf, 0, instData.buffer, 0, count * 32);
            kernel.dispatch(count);
        },

        get boneBuffer() {
            return kernel ? kernel.getBuffer('boneMatrices') : null;
        },

        destroy: () => {
            kernel?.destroy();
            kernel = null;
        },
    };
}
