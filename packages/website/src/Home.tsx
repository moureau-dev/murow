/* ---------- External ---------- */
import Newstack from "@moureau/newstack";

/**
 * @description
 * This is the Home page of the Newstack example application.
 * It demonstrates a simple interactive component with a counter.
 */
export class Home extends Newstack {
  /* ---------- Proxies ---------- */
  count = 0;

  /* ---------- Lifecycle ---------- */
  prepare({ page }) {
    page.title = "Newstack";
    page.description = "Welcome to Newstack";
  }

  render() {
    return (
      <div class="home">
        <h1>Welcome to Newstack!</h1>
        <p>Get started by editing <code>src/Home.tsx</code></p>

        <button onclick={() => this.count++}>
          Count: {this.count}
        </button>
      </div>
    );
  }
}
