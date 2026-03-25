/**
 * @description
 * A callback-based event handling system designed to simplify
 * event-driven programming.
 */
export class EventSystem {
    constructor({ events }) {
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
    on(name, callback) {
        const event = this.callbacks.get(name);
        if (!event)
            return console.warn(`Event "${name}" does not exist.`);
        event.add(callback);
    }
    /**
     * @description
     * Registers a callback for an event that runs only once.
     *
     * @param name Event name
     * @param callback Callback to run when the event is emitted
     */
    once(name, callback) {
        const wrapper = (props) => {
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
    emit(name, data) {
        const event = this.callbacks.get(name);
        if (!event)
            return console.warn(`Event "${name}" does not exist.`);
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
    off(name, callback) {
        const event = this.callbacks.get(name);
        if (!event)
            return console.warn(`Event "${name}" does not exist.`);
        event.delete(callback);
    }
    /**
     * @description
     * Removes all callbacks.
     *
     * @param name Optional event name
     */
    clear(name) {
        if (!name) {
            this.callbacks.clear();
            for (const name of this.events) {
                this.callbacks.set(name, new Set());
            }
            return;
        }
        const event = this.callbacks.get(name);
        if (!event)
            return console.warn(`Event "${name}" does not exist.`);
        event.clear();
    }
}
