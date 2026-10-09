import { describe, expect, test } from 'bun:test';
import {
    DynamicMesh,
    EngineMaterialUniforms,
    Light,
    MeshUniforms,
    SkinnedStaticMesh,
    StaticMesh,
} from './structs';

describe('environment structs', () => {
    test('MeshUniforms has the exact field order', () => {
        expect(MeshUniforms.fields.map((f) => f.name)).toEqual([
            'viewProjection',
            'alpha',
            'lightDirX',
            'lightDirY',
            'lightDirZ',
            'lightDirR',
            'lightDirG',
            'lightDirB',
            'lightDirIntensity',
            'ambientR',
            'ambientG',
            'ambientB',
            'lightCount',
            'cameraX',
            'cameraY',
            'cameraZ',
            'time',
            'resolutionX',
            'resolutionY',
        ]);
        expect(MeshUniforms.member('lightCount')!.field.type).toEqual({ kind: 'scalar', scalar: 'u32' });
        expect(MeshUniforms.member('viewProjection')!.field.type).toEqual({ kind: 'mat', scalar: 'f32', cols: 4, rows: 4 });
    });

    test('EngineMaterialUniforms has 12 f32 fields', () => {
        expect(EngineMaterialUniforms.fields.map((f) => f.name)).toEqual([
            'colorR',
            'colorG',
            'colorB',
            'opacity',
            'emissive',
            'alphaTest',
            'uvScaleU',
            'uvScaleV',
            'uvOffsetU',
            'uvOffsetV',
            'receiveShadow',
            'extrude',
        ]);
        expect(EngineMaterialUniforms.fields).toHaveLength(12);
    });

    test('Light has 22 fields in order', () => {
        expect(Light.fields.map((f) => f.name)).toEqual([
            'kind',
            'currPosX',
            'currPosY',
            'currPosZ',
            'prevPosX',
            'prevPosY',
            'prevPosZ',
            'currDirX',
            'currDirY',
            'currDirZ',
            'prevDirX',
            'prevDirY',
            'prevDirZ',
            'colorR',
            'colorG',
            'colorB',
            'intensity',
            'range',
            'innerCos',
            'outerCos',
            'castsShadow',
            'shadowMapIndex',
        ]);
        expect(Light.fields).toHaveLength(22);
    });

    test('mesh instance structs have their field counts', () => {
        expect(DynamicMesh.fields).toHaveLength(12);
        expect(StaticMesh.fields).toHaveLength(9);
        expect(SkinnedStaticMesh.fields).toHaveLength(8);
    });

    test('SkinnedStaticMesh keeps boneOffset unsigned', () => {
        expect(SkinnedStaticMesh.member('boneOffset')!.field.type).toEqual({ kind: 'scalar', scalar: 'u32' });
        expect(SkinnedStaticMesh.fields.map((f) => f.name)).toEqual([
            'scaleX',
            'scaleY',
            'scaleZ',
            'colorR',
            'colorG',
            'colorB',
            'boneOffset',
            'materialId',
        ]);
    });

    test('exposes a struct type descriptor', () => {
        const type = Light.type;
        expect(type.kind).toBe('struct');
        expect(type.name).toBe('Light');
        expect(type.fields).toHaveLength(22);
        expect(type.fields[0]).toEqual({ name: 'kind', type: { kind: 'scalar', scalar: 'f32' } });
    });
});
