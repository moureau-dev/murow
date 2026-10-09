import type { RendererCore } from '../../core';
import type { InstanceManager } from '../../managers/instances';
import type { MaterialManager } from '../../managers/materials';

/**
 * Records the main mesh pass. Draws the non-skinned batches (opaque first, then
 * transparent) and the skinned batches, using each batch's compiled material
 * when present and falling back to the engine pipelines otherwise.
 */
export class MainPass {
    constructor(
        private readonly core: RendererCore,
        private readonly instances: InstanceManager,
        private readonly materials: MaterialManager,
    ) {}

    record(pass: GPURenderPassEncoder): void {
        let currentPipeline: GPURenderPipeline | null = null;
        const batches = this.instances.batchOffsets;
        const batchCount = this.instances.batchCount;

        for (let passIndex = 0; passIndex < 2; passIndex++) {
            currentPipeline = null;

            for (let bi = 0; bi < batchCount; bi++) {
                const batch = batches[bi]!;
                const model = this.core.models.get(batch.modelId);
                if (!model) continue;

                const material = batch.materialId > 0 ? this.materials.library.get(batch.materialId) : null;
                const transparent = material ? material.transparent : false;
                if ((passIndex === 1) !== transparent) continue;

                if (material) {
                    if (material.pipeline !== currentPipeline) {
                        pass.setPipeline(material.pipeline);
                        pass.setBindGroup(0, this.core.pipelines.rawBindGroup);
                        currentPipeline = material.pipeline;
                    }
                    pass.setBindGroup(1, material.bindGroup);
                    pass.setVertexBuffer(0, model.rawVertexBuffer);
                    if (model.rawIndexBuffer) {
                        pass.setIndexBuffer(model.rawIndexBuffer, model.indexFormat);
                        pass.drawIndexed(model.indexCount, batch.count, 0, 0, batch.offset);
                    } else {
                        pass.draw(model.vertexCount, batch.count, 0, batch.offset);
                    }
                    continue;
                }

                let hasCustomTex = false;
                for (let i = 0; i < batch.count; i++) {
                    const slot = this.instances.store.slotIndexData[batch.offset + i]!;
                    if (this.instances.store.textureBindGroup(slot) !== undefined) {
                        hasCustomTex = true;
                        break;
                    }
                }

                const needsTextured = model.hasTexture || hasCustomTex;
                const pipeline = needsTextured ? this.core.pipelines.rawTexturedPipeline : this.core.pipelines.rawPipeline;
                if (pipeline !== currentPipeline) {
                    pass.setPipeline(pipeline);
                    pass.setBindGroup(0, this.core.pipelines.rawBindGroup);
                    currentPipeline = pipeline;
                }

                if (!needsTextured) {
                    pass.setVertexBuffer(0, model.rawVertexBuffer);
                    if (model.rawIndexBuffer) {
                        pass.setIndexBuffer(model.rawIndexBuffer, model.indexFormat);
                        pass.drawIndexed(model.indexCount, batch.count, 0, 0, batch.offset);
                    } else {
                        pass.draw(model.vertexCount, batch.count, 0, batch.offset);
                    }
                    continue;
                }

                pass.setVertexBuffer(0, model.rawVertexBuffer);
                if (model.rawIndexBuffer) pass.setIndexBuffer(model.rawIndexBuffer, model.indexFormat);
                const whiteBG = this.core.textures.white;
                for (let i = 0; i < batch.count; i++) {
                    const slot = this.instances.store.slotIndexData[batch.offset + i]!;
                    const customBG = this.instances.store.textureBindGroup(slot);
                    pass.setBindGroup(1, customBG ?? model.textureBindGroup ?? whiteBG);
                    if (model.rawIndexBuffer) {
                        pass.drawIndexed(model.indexCount, 1, 0, 0, batch.offset + i);
                    } else {
                        pass.draw(model.vertexCount, 1, 0, batch.offset + i);
                    }
                }
            }
        }

        currentPipeline = null;
        const skinnedBatches = this.instances.skinnedBatchOffsets;
        const skinnedBatchCount = this.instances.skinnedBatchCount;
        const skinned = this.instances.skinnedStore;
        const whiteBG = this.core.textures.white;

        for (let bi = 0; bi < skinnedBatchCount; bi++) {
            const batch = skinnedBatches[bi]!;
            const model = this.core.models.get(batch.modelId);
            if (!model) continue;

            // Any instance in this batch drawn with a material pipeline?
            let hasMaterial = false;
            for (let i = 0; i < batch.count && !hasMaterial; i++) {
                const slot = skinned.slotIndexData[batch.offset + i]!;
                const mc = skinned.materialCountOf(slot);
                for (let mi = 0; mi < mc; mi++) {
                    const mid = skinned.materialAt(slot, mi);
                    if (mid <= 0) continue;
                    const m = this.materials.library.get(mid);
                    if (m && m.skinnedPipeline) { hasMaterial = true; break; }
                }
            }

            if (!hasMaterial) {
                let hasCustomTex = false;
                for (let i = 0; i < batch.count; i++) {
                    const slot = skinned.slotIndexData[batch.offset + i]!;
                    if (skinned.textureBindGroup(slot) !== undefined) { hasCustomTex = true; break; }
                }

                const needsTextured = model.hasTexture || hasCustomTex;
                const pipeline = needsTextured ? this.core.pipelines.rawSkinnedTexturedPipeline : this.core.pipelines.rawSkinnedPipeline;
                if (pipeline !== currentPipeline) {
                    pass.setPipeline(pipeline);
                    pass.setBindGroup(0, this.core.pipelines.rawSkinnedBindGroup);
                    currentPipeline = pipeline;
                }

                if (!needsTextured) {
                    pass.setVertexBuffer(0, model.rawVertexBuffer);
                    if (model.rawIndexBuffer) {
                        pass.setIndexBuffer(model.rawIndexBuffer, model.indexFormat);
                        pass.drawIndexed(model.indexCount, batch.count, 0, 0, batch.offset);
                    } else {
                        pass.draw(model.vertexCount, batch.count, 0, batch.offset);
                    }
                    continue;
                }

                pass.setVertexBuffer(0, model.rawVertexBuffer);
                if (model.rawIndexBuffer) pass.setIndexBuffer(model.rawIndexBuffer, model.indexFormat);
                for (let i = 0; i < batch.count; i++) {
                    const slot = skinned.slotIndexData[batch.offset + i]!;
                    const customBG = skinned.textureBindGroup(slot);
                    pass.setBindGroup(1, customBG ?? model.textureBindGroup ?? whiteBG);
                    if (model.rawIndexBuffer) pass.drawIndexed(model.indexCount, 1, 0, 0, batch.offset + i);
                    else pass.draw(model.vertexCount, 1, 0, batch.offset + i);
                }
                currentPipeline = null;
                continue;
            }

            // Per-instance material loop: draw each instance once per material.
            pass.setVertexBuffer(0, model.rawVertexBuffer);
            if (model.rawIndexBuffer) pass.setIndexBuffer(model.rawIndexBuffer, model.indexFormat);
            for (let i = 0; i < batch.count; i++) {
                const slot = skinned.slotIndexData[batch.offset + i]!;
                const mc = skinned.materialCountOf(slot);
                for (let mi = 0; mi < mc; mi++) {
                    const mid = skinned.materialAt(slot, mi);
                    const material = mid > 0 ? this.materials.library.get(mid) : null;
                    if (material && material.skinnedPipeline) {
                        pass.setPipeline(material.skinnedPipeline);
                        pass.setBindGroup(0, this.core.pipelines.rawSkinnedBindGroup);
                        pass.setBindGroup(1, material.bindGroup);
                    } else {
                        const customBG = skinned.textureBindGroup(slot);
                        const needsTex = model.hasTexture || customBG !== undefined;
                        pass.setPipeline(needsTex ? this.core.pipelines.rawSkinnedTexturedPipeline : this.core.pipelines.rawSkinnedPipeline);
                        pass.setBindGroup(0, this.core.pipelines.rawSkinnedBindGroup);
                        if (needsTex) pass.setBindGroup(1, customBG ?? model.textureBindGroup ?? whiteBG);
                    }
                    if (model.rawIndexBuffer) pass.drawIndexed(model.indexCount, 1, 0, 0, batch.offset + i);
                    else pass.draw(model.vertexCount, 1, 0, batch.offset + i);
                }
            }
            currentPipeline = null;
        }
    }
}
