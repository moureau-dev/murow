/* ---------- External ---------- */
import { NewstackServer } from "@moureau/newstack/server";

/* ---------- Entrypoint ---------- */
import { Application } from "./src/Application";

const app = new Application();
const server = new NewstackServer();
server.start(app);
