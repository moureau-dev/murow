import { PeerRenderStrategy } from './strategy';
import { SnapshotInterpolationStrategy, type SnapshotInterpolationOptions } from './interpolation';
import { ExtrapolationStrategy, type ExtrapolationOptions } from './extrapolation';
import { HybridStrategy, type HybridOptions } from './hybrid';

/**
 * A peer-render strategy as data: a `kind` plus that strategy's options.
 * Pass one as `GameClient`'s `strategy`; the client instantiates the class.
 * Pass a `PeerRenderStrategy` instance instead for a custom strategy.
 */
export type PeerRenderStrategyConfig =
    | ({ readonly kind: 'snapshot-interpolation' } & SnapshotInterpolationOptions)
    | ({ readonly kind: 'extrapolation' } & ExtrapolationOptions)
    | ({ readonly kind: 'hybrid' } & HybridOptions);

/** Build a strategy instance from a {@link PeerRenderStrategyConfig}. */
export function createStrategy(config: PeerRenderStrategyConfig): PeerRenderStrategy {
    switch (config.kind) {
        case 'snapshot-interpolation':
            return new SnapshotInterpolationStrategy(config);
        case 'extrapolation':
            return new ExtrapolationStrategy(config);
        case 'hybrid':
            return new HybridStrategy(config);
    }
}
