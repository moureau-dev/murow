import { Shared } from "../shared";
import { Constants } from "./constants";
import { PixiRenderer } from "./renderer";

import type { InputSnapshot } from "../../../../packages/murow/src/core/input/types";
import { Utils } from "../shared/utils";

export class Game extends Shared.Game {
    renderer: PixiRenderer;
    private playerEid: number = -1;

    constructor() {
        super({ type: "client" });

        this.renderer = new PixiRenderer();

        this.events.on("render", ({ alpha }) => {
            this.renderer.render(this.world, alpha);
        });

        this.events.on("pre-tick", ({ input }) => {
            this.renderer.storePreviousState(this.world);
            this.inputs(input);
        });

        this.events.on("tick", ({ deltaTime }) => {
            this.world.runSystems(deltaTime);
            this.renderer.cleanup(this.world);
        });

        this.setup();
    }

    override async start() {
        await this.renderer.init();
        this.spawn();
        super.start();
    }

    override spawn() {
        const id = 1;
        this.playerEid = super.spawn();
        this.world.entity(this.playerEid).add(Shared.Components.Player, { id });
        return this.playerEid;
    }

    private setup() {
        Shared.Systems.boost(this.world);
        Shared.Systems.movement(this.world);
        Shared.Systems.gridBound(this.world, this.grid);
        Shared.Systems.territory(this.world, this.grid);
        Shared.Systems.trail(this.world, this.grid);
    }

    private inputs(input: InputSnapshot) {
        if (!this.world.isAlive(this.playerEid)) return;

        // Get desired direction from Keyboard
        let dir: Shared.Enums.Direction | undefined;
        for (const k in Constants.DirectionMap) {
            const button = input.keys[k];
            if (!button?.hit) continue;

            const direction = Constants.DirectionMap[k as Key];
            dir = direction;
            break;
        }

        const { Boost, Direction } = Shared.Components;

        const boosting = this.world.get(this.playerEid, Boost);
        const shouldBoost = !!input.keys["Space"]?.down;
        const shouldChangeDirection = dir !== undefined;

        if (boosting.enabled !== shouldBoost) {
            this.world.update(this.playerEid, Boost, { enabled: shouldBoost });
        }

        if (shouldChangeDirection) {
            const direction = this.world.get(this.playerEid, Direction);
            if (Utils.areOppositeDirections(direction.current, dir!)) return;
            this.world.update(this.playerEid, Direction, { current: dir });
        }
    }
}

type Key = keyof typeof Constants.DirectionMap;
