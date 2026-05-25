import { describe, test, expect } from 'bun:test';
import { f32, u16 } from 'murow/core/binary-codec';
import { defineComponent, World } from 'murow/ecs';
import { encodeDelta, decodeDelta } from './delta-codec';

describe('delta codec', () => {
    const Position = defineComponent('Position', {
        schema: { x: f32, y: f32 },
        sync: { rate: 'every-tick', interest: 'global' },
    });
    const Health = defineComponent('Health', {
        schema: { hp: u16 },
        sync: { rate: 'on-change', interest: 'global' },
    });

    test('roundtrip preserves component values', () => {
        const server = new World({ maxEntities: 64, components: [Position, Health] });
        const a = server.spawn();
        const b = server.spawn();
        server.add(a, Position, { x: 1, y: 2 });
        server.add(a, Health, { hp: 100 });
        server.add(b, Position, { x: -5, y: 10 });
        server.add(b, Health, { hp: 50 });

        const buf = encodeDelta(server, 42, [a, b], [Position, Health], 1);

        const client = new World({ maxEntities: 64, components: [Position, Health] });
        const result = decodeDelta(client, buf, [Position, Health], 1, (serverEid) => {
            // Direct id mapping for the test.
            const localEid = client.spawn();
            return localEid;
        });

        expect(result.tick).toBe(42);
        expect(result.entityIds.length).toBe(2);

        const [aClient, bClient] = result.entityIds;
        const aPos = client.get(aClient, Position);
        expect(aPos.x).toBeCloseTo(1);
        expect(aPos.y).toBeCloseTo(2);
        expect(client.get(aClient, Health).hp).toBe(100);

        const bPos = client.get(bClient, Position);
        expect(bPos.x).toBeCloseTo(-5);
        expect(bPos.y).toBeCloseTo(10);
        expect(client.get(bClient, Health).hp).toBe(50);
    });

    test('an empty entity list produces a minimal packet that still decodes', () => {
        const server = new World({ maxEntities: 8, components: [Position] });
        const buf = encodeDelta(server, 7, [], [Position], 1);
        const client = new World({ maxEntities: 8, components: [Position] });
        const result = decodeDelta(client, buf, [Position], 1, () => 0);
        expect(result.tick).toBe(7);
        expect(result.entityIds).toEqual([]);
    });
});
