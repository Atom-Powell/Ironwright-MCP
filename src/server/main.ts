import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { buildServer } from "../mcp/build-server.js";

const config = loadConfig(process.env);
const app = createApp({
  serverFactory: () => buildServer({ allowWrites: config.allowWrites }),
});

const server = app.listen(config.port, () => {
  console.log(`listening on port ${config.port}, writes ${config.allowWrites ? "enabled" : "disabled"}`);
});

// Container Apps sends SIGTERM on scale-in and on a revision swap, and Node's
// default action for it is immediate termination, which drops whatever requests
// are in flight. Idle keep-alive sockets are closed explicitly because otherwise
// they hold the server open until their own timeout, well past the platform's
// grace period, and the process is killed anyway.
process.on("SIGTERM", () => {
  console.log("received SIGTERM, finishing in-flight requests before exit");
  server.close(() => {
    process.exit(0);
  });
  server.closeIdleConnections();
});
