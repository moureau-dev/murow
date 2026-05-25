import { GameLoop, type DriverType, World } from 'murow';
import { Components } from './components';
import { TICK_RATE } from './constants';

/**
 * Per-process world + loop pair sharing the same component schema and tick
 * rate on both sides. The `type` argument picks the loop driver
 * (`'client'` for RAF-driven, `'server-timeout'` for fixed-step server,
 * `'server-immediate'` for tests).
 */
export class Arena<T extends DriverType = 'client'> {
    readonly world: World;
    readonly loop: GameLoop<T>;

    constructor(public readonly type: T, opts?: { maxEntities?: number }) {
        this.world = new World({
            maxEntities: opts?.maxEntities ?? 256,
            components: [Components.Position, Components.Color],
        });
        this.loop = new GameLoop({ type, tickRate: TICK_RATE });
    }
}
