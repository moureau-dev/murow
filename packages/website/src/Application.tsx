/* ---------- External ---------- */
import Newstack, { NewstackClientContext } from "@moureau/newstack";

/* ---------- Pages ---------- */
import { Home } from "./Home";

/* ---------- Styles ---------- */
import "./styles.css";

export class Application extends Newstack {
  prepare({ project }: NewstackClientContext) {
    project.domain = "murow.moureau.dev";
    project.name = "Murow";
    project.shortName = "Murow";
  }

  render() {
    return (
      <main>
        <Home route="/" />
      </main>
    );
  }
}
