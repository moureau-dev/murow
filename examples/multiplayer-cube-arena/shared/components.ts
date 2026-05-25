import { defineComponent, f32, u8 } from 'murow';
import { networked } from 'murow/netcode';


export namespace Components {
    /**
    * 2D world position on the XZ plane (Y is always 0 — players can't jump).
    * Synced every tick, interpolated linearly on the client.
    */
    export const Position = defineComponent('Position', {
        schema: { x: f32, z: f32 },
        sync: networked({ rate: 'every-tick', interest: 'global', interp: 'lerp' }),
    });

    /**
    * RGB color, 0-255 per channel. Picked per peer at spawn time, never
    * changes after that, so on-change is enough.
    */
    export const Color = defineComponent('Color', {
        schema: { r: u8, g: u8, b: u8 },
        sync: networked({ rate: 'on-change', interest: 'global', interp: 'step' }),
    });
}
