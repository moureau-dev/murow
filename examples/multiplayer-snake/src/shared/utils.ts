import { Shared } from ".";

export namespace Utils {
    const OPPOSITE_DIRECTIONS = [
        [Shared.Enums.Direction.up, Shared.Enums.Direction.down],
        [Shared.Enums.Direction.left, Shared.Enums.Direction.right],
    ];

    export function areOppositeDirections(
        dir: Shared.Enums.Direction,
        comparison: Shared.Enums.Direction,
    ) {
        const index = OPPOSITE_DIRECTIONS.findIndex((arr) => arr.includes(dir));

        return OPPOSITE_DIRECTIONS[index]?.includes(comparison);
    }
}
