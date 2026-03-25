type Callback<Props> = (props: Props) => void;
type EventMapFromTuple<T extends [string, unknown][]> = {
    [K in T[number] as K[0]]: K[1];
};
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
export declare class EventSystem<EventTuple extends [string, unknown][]> {
    /**
     * @private
     * @description
     * The map of registered events and their callbacks.
    */
    private callbacks;
    /**
     * @private
     * @description
     * The list of events that were registered.
    */
    private events;
    constructor({ events }: EventSystemProps<string>);
    /**
     * @description
     * Registers a callback for an event.
     *
     * @param name Event name
     * @param callback Callback to run when the event is emitted
     */
    on<EventName extends keyof EventMapFromTuple<EventTuple> & string>(name: EventName, callback: Callback<EventMapFromTuple<EventTuple>[EventName]>): void;
    /**
     * @description
     * Registers a callback for an event that runs only once.
     *
     * @param name Event name
     * @param callback Callback to run when the event is emitted
     */
    once<EventName extends keyof EventMapFromTuple<EventTuple> & string>(name: EventName, callback: Callback<EventMapFromTuple<EventTuple>[EventName]>): void;
    /**
     * @description
     * Emits an event, running all registered callbacks.
     *
     * @param name Event name
     * @param data Event data
     */
    emit<EventName extends keyof EventMapFromTuple<EventTuple> & string>(name: EventName, data: EventMapFromTuple<EventTuple>[EventName]): void;
    /**
     * @description
     * Removes a callback from an event.
     *
     * @param name Event name
     * @param callback Callback to remove
     */
    off<EventName extends keyof EventMapFromTuple<EventTuple> & string>(name: EventName, callback: Callback<EventMapFromTuple<EventTuple>[EventName]>): void;
    /**
     * @description
     * Removes all callbacks.
     *
     * @param name Optional event name
     */
    clear<EventName extends keyof EventMapFromTuple<EventTuple> & string>(name?: EventName): void;
}
export {};
