import { World } from "../../../../src";
import { Components } from "./components";
import { Enums } from "./enums";
import { Grid } from "./grid";
import { Constants } from "./constants";

export namespace Systems {
    export function movement(world: World) {
        const SPEED = {
            normal: Constants.CELL_SIZE * 5, // 5 cells per second
            boosting: Constants.CELL_SIZE * 8, // 8 cells per second
        };

        const MOVEMENT_MAP: Record<Enums.Direction, [number, number]> = {
            [Enums.Direction.up]: [0, -1],
            [Enums.Direction.down]: [0, 1],
            [Enums.Direction.left]: [-1, 0],
            [Enums.Direction.right]: [1, 0],
        };

        world
            .addSystem()
            .query(
                Components.Position,
                Components.Direction,
                Components.Health,
                Components.Boost,
            )
            .fields([
                { position: ["x", "y"] },
                { dir: ["current"] },
                { health: ["alive"] },
                { boosting: ["enabled", "fuel"] },
            ])
            .when((entity) => entity.health_alive)
            .run((entity, deltaTime) => {
                const boosting = entity.boosting_enabled;
                const speed = boosting ? SPEED.boosting : SPEED.normal;

                const distance = deltaTime * speed;

                const direction: Enums.Direction = entity.dir_current;
                const [dx, dy] = MOVEMENT_MAP[direction];

                entity.position_x += dx * distance;
                entity.position_y += dy * distance;
            });
    }

    export function gridBound(world: World, grid: Grid) {
        world
            .addSystem()
            .query(Components.Position)
            .fields([{ position: ["x", "y"] }])
            .run((entity) => {
                entity.position_x = Math.max(
                    0,
                    Math.min(
                        Constants.CELL_SIZE * (grid.size - 1),
                        entity.position_x,
                    ),
                );

                entity.position_y = Math.max(
                    0,
                    Math.min(
                        Constants.CELL_SIZE * (grid.size - 1),
                        entity.position_y,
                    ),
                );
            });
    }

    export function boost(world: World) {
        world
            .addSystem()
            .query(Components.Boost)
            .fields([{ boost: ["enabled", "fuel"] }])
            .run((entity, deltaTime) => {
                if (entity.boost_enabled) {
                    if ((entity.boost_fuel as number) <= 0) {
                        entity.boost_enabled = false;
                        return;
                    }

                    (entity.boost_fuel as number) -= deltaTime;
                }
            });
    }

    export function trail(world: World, grid: Grid) {
        world
            .addSystem()
            .query(Components.Position, Components.Health)
            .fields([{ pos: ["x", "y"] }, { health: ["alive"] }])
            .when((e) => e.health_alive)
            .run((e) => {
                const x = Math.floor(e.pos_x / Constants.CELL_SIZE);
                const y = Math.floor(e.pos_y / Constants.CELL_SIZE);

                const cellEid = grid.find(x, y);
                if (cellEid === undefined) return;

                const cell = world.get(cellEid, Components.Cell);

                // if player is outside his territory
                if (cell.owner !== e.eid) {
                    if (cell.state !== Enums.CellState.trail) {
                        world.update(cellEid, Components.Cell, {
                            state: Enums.CellState.trail,
                            owner: e.eid,
                        });
                    }
                }
            });
    }

    export function territory(world: World, grid: Grid) {
        function closeLoop(world: World, player: number) {
            const cells = world.query(Components.Cell);

            let foundTrail = false;

            for (const cellEid of cells) {
                const cell = world.get(cellEid, Components.Cell);

                if (
                    cell.state === Enums.CellState.trail &&
                    cell.owner === player
                ) {
                    foundTrail = true;

                    world.update(cellEid, Components.Cell, {
                        state: Enums.CellState.captured,
                        owner: player,
                    });
                }
            }

            if (!foundTrail) return;
        }

        world
            .addSystem()
            .query(Components.Position, Components.Health, Components.LastCell)
            .fields([
                { pos: ["x", "y"] },
                { health: ["alive"] },
                { last: ["x", "y"] },
            ])
            .when((e) => e.health_alive)
            .run((e) => {
                const x = Math.floor(e.pos_x / Constants.CELL_SIZE);
                const y = Math.floor(e.pos_y / Constants.CELL_SIZE);

                // only run when entering a new cell
                if (x === e.last_x && y === e.last_y) return;

                const cellEid = grid.find(x, y);
                if (cellEid === undefined) return;

                const cell = world.get(cellEid, Components.Cell);

                // trail collision
                if (cell.state === Enums.CellState.trail) {
                    // self trail → you die
                    if (cell.owner === e.eid) {
                        world.update(e.eid, Components.Health, {
                            alive: false,
                        });
                        return;
                    }

                    // enemy trail → enemy dies
                    if (cell.owner !== 0) {
                        world.update(cell.owner, Components.Health, {
                            alive: false,
                        });
                    }
                }

                // outside territory → create trail
                if (cell.owner !== e.eid) {
                    world.update(cellEid, Components.Cell, {
                        state: Enums.CellState.trail,
                        owner: e.eid,
                    });
                }
                // returned to own territory → close loop
                else {
                    closeLoop(world, e.eid);
                }

                // update last cell
                e.last_x = x;
                e.last_y = y;
            });
    }
}
