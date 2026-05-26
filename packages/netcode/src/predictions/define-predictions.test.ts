import { describe, test, expect } from 'bun:test';
import { f32 } from 'murow/core/binary-codec';
import { SimpleRNG } from 'murow/core/simple-rng';
import { defineComponent, World } from 'murow/ecs';
import { defineIntents } from '../intents/define-intents';
import { definePredictions } from './define-predictions';

describe('definePredictions / defineHandlers', () => {
    const Velocity = defineComponent('Velocity', {
        schema: { vx: f32, vy: f32 },
        sync: { rate: 'every-tick', interest: 'global' },
    });

    test('a prediction function is called with the typed payload', () => {
        const intents = defineIntents({
            move: { dx: f32, dy: f32 },
        });
        let captured: any = null;
        const predictions = definePredictions(intents, {
            move: (payload, ctx) => {
                captured = { payload, hasWorld: ctx.world !== undefined };
            },
        });

        // Drive the prediction directly to verify the bundle's shape.
        const world = new World({ maxEntities: 8, components: [Velocity] });
        const entity = world.spawn();
        world.add(entity, Velocity, { vx: 0, vy: 0 });

        predictions.map.move!({ dx: 1, dy: -2 }, {
            world,
            entity,
            tick: 0,
            deltaTime: 0.016,
            rng: new SimpleRNG(1),
        });

        expect(captured.payload.dx).toBe(1);
        expect(captured.payload.dy).toBe(-2);
        expect(captured.hasWorld).toBe(true);
    });

    test('tagged with __kind: "predictions"', () => {
        const intents = defineIntents({ ping: {} });
        const predictions = definePredictions(intents, { ping: () => { } });
        expect(predictions.__kind).toBe('predictions');
    });
});
