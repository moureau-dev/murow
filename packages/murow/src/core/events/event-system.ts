/* ---------- Types ---------- */
type Callback<Props> = (props: Props) => void;


type EventMapFromTuple<T extends [string, unknown][]> = {
    [K in T[number]as K[0]]: K[1];
};

/* ---------- Interfaces ---------- */
interface EventSystemProps<EventNames extends string> {
    /**
     * @description
     * The list of events to ever be registered.
     */
    events: EventNames[];
}

/**
 * @description
 * A callback-based event handling system designed to simplify 
 * event-driven programming.
 */
export class EventSystem<EventTuple extends [string, unknown][]> {
    /**
     * @private
     * @description
     * The map of registered events and their callbacks.
    */
    private callbacks: Map<string, Set<Callback<unknown>>>;

    /**
     * @private
     * @description
     * The list of events that were registered.
    */
    private events: string[];

    constructor({ events }: EventSystemProps<string>) {
        this.callbacks = new Map();
        this.events = events;

        for (const name of this.events) {
            this.callbacks.set(name, new Set());
        }
    }

    /**
     * @description
     * Registers a callback for an event.
     *
     * @param name Event name
     * @param callback Callback to run when the event is emitted
     */
    on<EventName extends keyof EventMapFromTuple<EventTuple> & string>(
        name: EventName,
        callback: Callback<EventMapFromTuple<EventTuple>[EventName]>
    ): void {
        const event = this.callbacks.get(name) as Set<Callback<EventMapFromTuple<EventTuple>[EventName]>> | undefined;
        if (!event) return console.warn(`Event "${name}" does not exist.`);

        event.add(callback);
    }

    /**
     * @description
     * Registers a callback for an event that runs only once.
     *
     * @param name Event name
     * @param callback Callback to run when the event is emitted
     */
    once<EventName extends keyof EventMapFromTuple<EventTuple> & string>(
        name: EventName,
        callback: Callback<EventMapFromTuple<EventTuple>[EventName]>
    ): void {
        const wrapper: Callback<EventMapFromTuple<EventTuple>[EventName]> = (props) => {
            callback(props);
            this.off(name, wrapper);
        };

        this.on(name, wrapper);
    }

    /**
     * @description
     * Emits an event, running all registered callbacks.
     *
     * @param name Event name
     * @param data Event data
     */
    emit<EventName extends keyof EventMapFromTuple<EventTuple> & string>(
        name: EventName,
        data: EventMapFromTuple<EventTuple>[EventName]
    ) {
        const event = this.callbacks.get(name);
        if (!event) return console.warn(`Event "${name}" does not exist.`);

        for (const callback of event) {
            callback(data);
        }
    }

    /**
     * @description
     * Removes a callback from an event.
     *
     * @param name Event name
     * @param callback Callback to remove
     */
    off<EventName extends keyof EventMapFromTuple<EventTuple> & string>(
        name: EventName,
        callback: Callback<EventMapFromTuple<EventTuple>[EventName]>
    ): void {
        const event = this.callbacks.get(name) as Set<Callback<EventMapFromTuple<EventTuple>[EventName]>> | undefined;
        if (!event) return console.warn(`Event "${name}" does not exist.`);

        event.delete(callback);
    }

    /**
     * @description
     * Removes all callbacks.
     *
     * @param name Optional event name
     */
    clear<EventName extends keyof EventMapFromTuple<EventTuple> & string>(name?: EventName): void {
        if (!name) {
            this.callbacks.clear();
            for (const name of this.events) {
                this.callbacks.set(name, new Set());
            }

            return;
        }

        const event = this.callbacks.get(name);
        if (!event) return console.warn(`Event "${name}" does not exist.`);

        event.clear();
    }
}
