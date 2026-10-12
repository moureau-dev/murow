import { describe, test, expect } from 'bun:test';
import { createStrategy } from './config';
import { PeerRenderStrategy } from './strategy';
import { SnapshotInterpolationStrategy } from './interpolation';
import { ExtrapolationStrategy } from './extrapolation';
import { HybridStrategy } from './hybrid';

describe('createStrategy', () => {
    test('maps each kind to its strategy class', () => {
        expect(createStrategy({ kind: 'snapshot-interpolation' })).toBeInstanceOf(SnapshotInterpolationStrategy);
        expect(createStrategy({ kind: 'extrapolation', maxExtrapolationMs: 50 })).toBeInstanceOf(ExtrapolationStrategy);
        expect(createStrategy({ kind: 'hybrid', delay: 80 })).toBeInstanceOf(HybridStrategy);
    });
    test('every kind yields a PeerRenderStrategy', () => {
        expect(createStrategy({ kind: 'snapshot-interpolation' })).toBeInstanceOf(PeerRenderStrategy);
    });
});
