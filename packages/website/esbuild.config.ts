/* ---------- External ---------- */
import { builder } from "@moureau/newstack/builder";

export default {
  server: {
    ...builder.server,
  },
  client: {
    ...builder.client,
  },
};
