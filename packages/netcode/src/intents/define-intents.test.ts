import { describe, test, expect } from 'bun:test';
import { f32, u8 } from 'murow/core/binary-codec';
import { defineIntents } from './define-intents';

describe('defineIntents', () => {
    test('auto-assigns numeric kinds starting at 1', () => {
        const intents = defineIntents({
            move: { dx: f32, dy: f32 },
            jump: {},
            attack: { targetId: u8 },
        });
        expect(intents.kindByName.move).toBe(1);
        expect(intents.kindByName.jump).toBe(2);
        expect(intents.kindByName.attack).toBe(3);
    });

    test('exposes a registry that decodes encoded intents back to the right name', () => {
        const intents = defineIntents({
            move: { dx: f32, dy: f32 },
        });
        const def = intents.defs.move;
        const encoded = intents.registry.encode({
            kind: def.kind,
            tick: 5,
            dx: 1,
            dy: 2,
        });
        const decoded = intents.registry.decode(encoded) as any;
        expect(decoded.kind).toBe(def.kind);
        expect(decoded.tick).toBe(5);
        expect(decoded.dx).toBeCloseTo(1);
        expect(decoded.dy).toBeCloseTo(2);
        expect(intents.nameByKind[decoded.kind]).toBe('move');
    });

    test('two intents with different schemas roundtrip independently', () => {
        const intents = defineIntents({
            move: { dx: f32, dy: f32 },
            attack: { targetId: u8 },
        });

        const moveBuf = intents.registry.encode({
            kind: intents.defs.move.kind,
            tick: 0,
            dx: 0.5,
            dy: -0.5,
        });
        const attackBuf = intents.registry.encode({
            kind: intents.defs.attack.kind,
            tick: 1,
            targetId: 42,
        });

        const moveDecoded = intents.registry.decode(moveBuf) as any;
        const attackDecoded = intents.registry.decode(attackBuf) as any;
        expect(intents.nameByKind[moveDecoded.kind]).toBe('move');
        expect(intents.nameByKind[attackDecoded.kind]).toBe('attack');
        expect(attackDecoded.targetId).toBe(42);
    });
});
