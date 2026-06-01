/* ---------- External ---------- */
import Newstack from "@moureau/newstack";

/* ---------- Pages ---------- */
import { Home } from "./Home";

/* ---------- Styles ---------- */
import "./styles.css";

export class Application extends Newstack {
  render() {
    return (
      <div>
        <Home route="/" />
      </div>
    );
  }
}
