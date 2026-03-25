/**
 * AnimationController — frame-by-frame spritesheet animation.
 *
 * Manages animation clips (sequences of sprite frames with per-frame durations)
 * and updates sprite handles to show the current frame. Zero allocations in the
 * update loop — all clip data is pre-allocated typed arrays.
 *
 * ECS-independent: works with any system that can call update() per entity.
 *
 * Usage:
 * ```ts
 * const anim = new AnimationController();
 *
 * const runClip = anim.loadClip({
 *     name: 'run',
 *     frames: [0, 1, 2, 3],
 *     durations: [100, 100, 100, 100],
 *     loop: true,
 * });
 *
 * const state = anim.createState(runClip);
 * // Each tick:
 * anim.update(state, deltaTime, spriteHandle);
 * ```
 */

export interface AnimationClip {
    readonly id: number;
    readonly name: string;
    readonly frames: Uint16Array;
    readonly durations: Float32Array;
    readonly frameCount: number;
    readonly totalDuration: number;
    readonly loop: boolean;
}

export interface AnimationState {
    clipId: number;
    frame: number;
    time: number;
    speed: number;
    playing: boolean;
}

export interface AnimationClipConfig {
    name: string;
    frames: number[];
    durations: number[];
    loop: boolean;
}

/**
 * Minimal interface for what update() needs to set on a sprite.
 * Matches SpriteAccessor but doesn't import it — stays decoupled.
 */
export interface Animatable {
    setSpriteId?(id: number): void;
}

export class AnimationController {
    private clips: AnimationClip[] = [];
    private clipsByName: Map<string, number> = new Map();

    /**
     * Register an animation clip. Returns the clip ID.
     */
    loadClip(config: AnimationClipConfig): number {
        const id = this.clips.length;
        const clip: AnimationClip = {
            id,
            name: config.name,
            frames: new Uint16Array(config.frames),
            durations: new Float32Array(config.durations),
            frameCount: config.frames.length,
            totalDuration: config.durations.reduce((sum, d) => sum + d, 0),
            loop: config.loop,
        };
        this.clips.push(clip);
        this.clipsByName.set(config.name, id);
        return id;
    }

    /**
     * Get a clip by name.
     */
    getClipId(name: string): number {
        const id = this.clipsByName.get(name);
        if (id === undefined) throw new Error(`Animation clip "${name}" not found`);
        return id;
    }

    /**
     * Get a clip by ID.
     */
    getClip(id: number): AnimationClip {
        return this.clips[id];
    }

    /**
     * Create a new animation state for an entity. This is the per-entity data
     * that tracks playback progress. Store it however you like (flat array, component, etc).
     */
    createState(clipId: number, speed: number = 1, playing: boolean = true): AnimationState {
        return { clipId, frame: 0, time: 0, speed, playing };
    }

    /**
     * Advance an animation state by deltaTime (in seconds).
     * Returns the current sprite frame ID, or -1 if not playing.
     * Zero allocations.
     */
    update(state: AnimationState, deltaTime: number): number {
        if (!state.playing) {
            return this.clips[state.clipId].frames[state.frame];
        }

        const clip = this.clips[state.clipId];

        // Advance time (deltaTime is in seconds, durations are in ms)
        state.time += deltaTime * state.speed * 1000;

        // Advance frames
        while (state.time >= clip.durations[state.frame]) {
            state.time -= clip.durations[state.frame];
            state.frame++;

            if (state.frame >= clip.frameCount) {
                if (clip.loop) {
                    state.frame = 0;
                } else {
                    state.frame = clip.frameCount - 1;
                    state.playing = false;
                    break;
                }
            }
        }

        return clip.frames[state.frame];
    }

    /**
     * Play a different clip on an existing state. Resets frame and time.
     */
    play(state: AnimationState, clipId: number, speed?: number): void {
        state.clipId = clipId;
        state.frame = 0;
        state.time = 0;
        state.playing = true;
        if (speed !== undefined) state.speed = speed;
    }

    /**
     * Stop playback.
     */
    stop(state: AnimationState): void {
        state.playing = false;
    }

    /**
     * Resume playback.
     */
    resume(state: AnimationState): void {
        state.playing = true;
    }

    /**
     * Number of loaded clips.
     */
    get clipCount(): number {
        return this.clips.length;
    }
}
