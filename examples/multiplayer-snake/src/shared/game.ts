import { GameLoop, World, type GameLoopType } from "murow";
import { Components } from "./components";
import { Constants } from "./constants";
import { Enums } from "./enums";
import { Grid } from "./grid";

interface GameProps<T extends GameLoopType> {
    type: T;
}

export class Game<T extends GameLoopType> extends GameLoop<T> {
    world: World;
    grid: Grid;

    constructor({ type }: GameProps<T>) {
        super({ tickRate: Constants.TICK_RATE, type });

        this.world = new World({
            components: Object.values(Components),
            maxEntities: Constants.MAX_ENTITIES,
        });

        this.grid = new Grid();
        this.setupGrid();
    }

    spawn() {
        const entity = this.world
            .entity(this.world.spawn())
            .add(Components.Boost, { enabled: false, fuel: Constants.MAX_FUEL })
            .add(Components.Position, { x: 0, y: 0 })
            .add(Components.Direction, {
                current: Enums.Direction.right,
            })
            .add(Components.Sprite, {
                scale: 1,
                textureId: Math.random() > 0.5 ? 0 : 1,
            })
            .add(Components.LastCell, { x: 0, y: 0 })
            .add(Components.Chassis, { id: 1 })
            .add(Components.Health, { alive: true });

        const cellEid = this.grid.find(0, 0)!;

        this.world.update(cellEid, Components.Cell, {
            state: Enums.CellState.captured,
            owner: entity.id,
        });

        return entity.id;
    }

    private setupGrid() {
        for (let y = 0; y < this.grid.size; y++) {
            for (let x = 0; x < this.grid.size; x++) {
                const eid = this.world.spawn();

                this.world.add(eid, Components.Cell, {
                    x,
                    y,
                    state: Enums.CellState.free,
                    owner: 0,
                });

                this.grid.set(x, y, eid);
            }
        }
    }
}
