/* ---------- External ---------- */
import { NewstackClient } from "@moureau/newstack";

/* ---------- Entrypoint ---------- */
import { Application } from "./src/Application";

const app = new Application();
new NewstackClient().start(app);
