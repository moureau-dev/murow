import { BinaryCodec, defineComponent } from "../../../../packages/murow/src";

export namespace Components {
    export const Direction = defineComponent("dir", {
        current: BinaryCodec.i8,
    });

    export const Position = defineComponent("pos", {
        x: BinaryCodec.f32,
        y: BinaryCodec.f32,
    });

    export const Cell = defineComponent("cell", {
        x: BinaryCodec.i8,
        y: BinaryCodec.i8,
        state: BinaryCodec.i8,
        owner: BinaryCodec.i32,
    });

    export const Boost = defineComponent("boost", {
        enabled: BinaryCodec.bool,
        fuel: BinaryCodec.f32,
    });

    export const Chassis = defineComponent("skin", {
        id: BinaryCodec.i8,
    });

    export const Health = defineComponent("health", {
        alive: BinaryCodec.bool,
    });

    export const Sprite = defineComponent("Sprite", {
        textureId: BinaryCodec.u8,
        scale: BinaryCodec.f32,
    });

    export const LastCell = defineComponent("last-cell", {
        x: BinaryCodec.i8,
        y: BinaryCodec.i8,
    });

    export const Player = defineComponent("player", { id: BinaryCodec.i32 });
}
