# Input

The input system is responsible for managing user input from various sources, such as keyboard and mouse events. It provides a unified interface for querying the current state of input devices and handling input events.

## Key Components

- **InputManager**: The main class for managing input state and events. It tracks the state of keyboard and mouse inputs and provides methods for querying this state.
- **InputSnapshot**: A snapshot of the current input state, including the state of all keys and mouse buttons.
- **InputEventSource**: An interface for different input event sources (e.g., browser events, gamepad events) to provide input data to the InputManager.

## Usage

To use the input system, create an instance of the InputManager and listen for input events from the desired input source. You can then query the current input state using the `snapshot()` and `peek()` methods.

```typescript
const inputManager = new InputManager();
const inputSource = new BrowserInputSource(document, document.body);
inputManager.listen(inputSource);

// In your game loop
const inputSnapshot = inputManager.snapshot();
if (inputSnapshot.keys['Space'].hit) {
    // Handle space key hit
}
