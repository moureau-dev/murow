import { describe, test, expect } from 'bun:test';
import { networked, type SyncSpec } from './sync-spec';

describe('networked()', () => {
    test('returns the SyncSpec object as-is at runtime', () => {
        const spec = networked({ rate: 'every-tick', interest: 'aoi' });
        expect(spec).toEqual({ rate: 'every-tick', interest: 'aoi' });
    });

    test('accepts every valid rate literal', () => {
        const a = networked({ rate: 'every-tick', interest: 'global' });
        const b = networked({ rate: 'on-change', interest: 'global' });
        const c = networked({ rate: { every: 5 }, interest: 'global' });
        expect(a.rate).toBe('every-tick');
        expect(b.rate).toBe('on-change');
        expect((c.rate as { every: number }).every).toBe(5);
    });

    test('accepts custom interest names (any string is allowed)', () => {
        const a = networked({ rate: 'every-tick', interest: 'aoi' });
        const b = networked({ rate: 'every-tick', interest: 'sound-aoi' });
        expect(a.interest).toBe('aoi');
        expect(b.interest).toBe('sound-aoi');
    });

    test('interp and snapThreshold are optional and typed', () => {
        const spec: SyncSpec = networked({
            rate: 'every-tick',
            interest: 'global',
            interp: 'lerp',
            snapThreshold: 5,
        });
        expect(spec.interp).toBe('lerp');
        expect(spec.snapThreshold).toBe(5);
    });
});

describe('compile-time type checks', () => {
    test('typos in `rate` and `interp` are rejected', () => {
        // These lines must fail to compile if SyncSpec is typed correctly.
        // The `@ts-expect-error` directives are themselves checked by tsc:
        // if the call DOES compile, the directive becomes "unused" and tsc
        // fails the build.

        // @ts-expect-error — 'evry-tick' is a typo of 'every-tick'
        networked({ rate: 'evry-tick', interest: 'global' });

        // @ts-expect-error — 'always' is not a valid rate
        networked({ rate: 'always', interest: 'global' });

        // @ts-expect-error — `every` must be a number
        networked({ rate: { every: 'fast' }, interest: 'global' });

        // @ts-expect-error — interp must be one of the union members
        networked({ rate: 'every-tick', interest: 'global', interp: 'bouncy' });

        // @ts-expect-error — snapThreshold must be a number
        networked({ rate: 'every-tick', interest: 'global', snapThreshold: 'high' });

        // @ts-expect-error — missing required `interest`
        networked({ rate: 'every-tick' });

        // @ts-expect-error — missing required `rate`
        networked({ interest: 'global' });

        expect(true).toBe(true);
    });
});
