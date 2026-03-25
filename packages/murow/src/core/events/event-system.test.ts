import { describe, expect, test, spyOn } from "bun:test";
import { EventSystem } from "./event-system";

type TestEvents = [
  ["userJoined", { userId: string; name: string }],
  ["userLeft", { userId: string }],
  ["messageReceived", { from: string; message: string }],
  ["scoreUpdated", { playerId: string; score: number }]
];

describe("EventSystem", () => {
  test("should initialize with provided events", () => {
    const events = new EventSystem<TestEvents>({
      events: ["userJoined", "userLeft"],
    });
    expect(events).toBeDefined();
  });

  test("should register and call event callback", () => {
    const events = new EventSystem<TestEvents>({
      events: ["userJoined"],
    });

    let called = false;
    events.on("userJoined", (data) => {
      called = true;
      expect(data.userId).toBe("123");
      expect(data.name).toBe("Alice");
    });

    events.emit("userJoined", { userId: "123", name: "Alice" });
    expect(called).toBe(true);
  });

  test("should call multiple callbacks for same event", () => {
    const events = new EventSystem<TestEvents>({
      events: ["userJoined"],
    });

    let count = 0;
    events.on("userJoined", () => count++);
    events.on("userJoined", () => count++);
    events.on("userJoined", () => count++);

    events.emit("userJoined", { userId: "123", name: "Bob" });
    expect(count).toBe(3);
  });

  test("should handle once() callback that runs only once", () => {
    const events = new EventSystem<TestEvents>({
      events: ["messageReceived"],
    });

    let count = 0;
    events.once("messageReceived", () => count++);

    events.emit("messageReceived", { from: "Alice", message: "Hello" });
    events.emit("messageReceived", { from: "Bob", message: "Hi" });
    events.emit("messageReceived", { from: "Charlie", message: "Hey" });

    expect(count).toBe(1);
  });

  test("should remove callback with off()", () => {
    const events = new EventSystem<TestEvents>({
      events: ["scoreUpdated"],
    });

    let count = 0;
    const callback = () => count++;

    events.on("scoreUpdated", callback);
    events.emit("scoreUpdated", { playerId: "p1", score: 100 });
    expect(count).toBe(1);

    events.off("scoreUpdated", callback);
    events.emit("scoreUpdated", { playerId: "p1", score: 200 });
    expect(count).toBe(1); // Should still be 1
  });

  test("should clear specific event callbacks", () => {
    const events = new EventSystem<TestEvents>({
      events: ["userJoined", "userLeft"],
    });

    let joinCount = 0;
    let leaveCount = 0;

    events.on("userJoined", () => joinCount++);
    events.on("userJoined", () => joinCount++);
    events.on("userLeft", () => leaveCount++);

    events.clear("userJoined");

    events.emit("userJoined", { userId: "123", name: "Alice" });
    events.emit("userLeft", { userId: "123" });

    expect(joinCount).toBe(0);
    expect(leaveCount).toBe(1);
  });

  test("should clear all event callbacks", () => {
    const events = new EventSystem<TestEvents>({
      events: ["userJoined", "userLeft", "messageReceived"],
    });

    let count = 0;
    events.on("userJoined", () => count++);
    events.on("userLeft", () => count++);
    events.on("messageReceived", () => count++);

    events.clear();

    events.emit("userJoined", { userId: "123", name: "Alice" });
    events.emit("userLeft", { userId: "123" });
    events.emit("messageReceived", { from: "Alice", message: "Hi" });

    expect(count).toBe(0);
  });

  test("should warn when registering callback for non-existent event", () => {
    const events = new EventSystem<TestEvents>({
      events: ["userJoined"],
    });

    const consoleWarn = spyOn(console, "warn");
    // @ts-expect-error Testing invalid event name
    events.on("nonExistent", () => {});
    expect(consoleWarn).toHaveBeenCalledWith('Event "nonExistent" does not exist.');
    consoleWarn.mockRestore();
  });

  test("should warn when emitting non-existent event", () => {
    const events = new EventSystem<TestEvents>({
      events: ["userJoined"],
    });

    const consoleWarn = spyOn(console, "warn");
    // @ts-expect-error Testing invalid event name
    events.emit("nonExistent", {});
    expect(consoleWarn).toHaveBeenCalledWith('Event "nonExistent" does not exist.');
    consoleWarn.mockRestore();
  });

  test("should pass correct data to callbacks", () => {
    const events = new EventSystem<TestEvents>({
      events: ["scoreUpdated"],
    });

    const receivedData: Array<{ playerId: string; score: number }> = [];
    events.on("scoreUpdated", (data) => receivedData.push(data));

    events.emit("scoreUpdated", { playerId: "p1", score: 100 });
    events.emit("scoreUpdated", { playerId: "p2", score: 200 });

    expect(receivedData).toEqual([
      { playerId: "p1", score: 100 },
      { playerId: "p2", score: 200 },
    ]);
  });

  test("should handle callbacks that throw errors", () => {
    const events = new EventSystem<TestEvents>({
      events: ["userJoined"],
    });

    let successCount = 0;
    events.on("userJoined", () => {
      throw new Error("Callback error");
    });
    events.on("userJoined", () => successCount++);

    expect(() =>
      events.emit("userJoined", { userId: "123", name: "Alice" })
    ).toThrow();

    // First callback threw, so second wasn't reached
    expect(successCount).toBe(0);
  });

  test("should maintain callback order", () => {
    const events = new EventSystem<TestEvents>({
      events: ["messageReceived"],
    });

    const order: number[] = [];
    events.on("messageReceived", () => order.push(1));
    events.on("messageReceived", () => order.push(2));
    events.on("messageReceived", () => order.push(3));

    events.emit("messageReceived", { from: "Test", message: "Hello" });
    expect(order).toEqual([1, 2, 3]);
  });

  test("should allow same callback to be registered multiple times", () => {
    const events = new EventSystem<TestEvents>({
      events: ["userJoined"],
    });

    let count = 0;
    const callback = () => count++;

    events.on("userJoined", callback);
    events.on("userJoined", callback);

    events.emit("userJoined", { userId: "123", name: "Alice" });
    // Set only stores unique callbacks, so it should be called once
    expect(count).toBe(1);
  });

  test("should handle rapid event emissions", () => {
    const events = new EventSystem<TestEvents>({
      events: ["scoreUpdated"],
    });

    let count = 0;
    events.on("scoreUpdated", () => count++);

    for (let i = 0; i < 1000; i++) {
      events.emit("scoreUpdated", { playerId: "p1", score: i });
    }

    expect(count).toBe(1000);
  });

  test("should handle once() with multiple callbacks", () => {
    const events = new EventSystem<TestEvents>({
      events: ["userJoined"],
    });

    let count1 = 0;
    let count2 = 0;

    events.once("userJoined", () => count1++);
    events.on("userJoined", () => count2++);

    events.emit("userJoined", { userId: "123", name: "Alice" });
    events.emit("userJoined", { userId: "456", name: "Bob" });

    expect(count1).toBe(1);
    expect(count2).toBe(2);
  });
});
