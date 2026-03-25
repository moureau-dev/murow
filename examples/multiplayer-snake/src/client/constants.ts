import { Shared } from "../shared";

export namespace Constants {
    export const DirectionMap = {
        KeyW: Shared.Enums.Direction.up,
        KeyD: Shared.Enums.Direction.right,
        KeyS: Shared.Enums.Direction.down,
        KeyA: Shared.Enums.Direction.left,
        ArrowUp: Shared.Enums.Direction.up,
        ArrowRight: Shared.Enums.Direction.right,
        ArrowDown: Shared.Enums.Direction.down,
        ArrowLeft: Shared.Enums.Direction.left,
    } as const;
}
