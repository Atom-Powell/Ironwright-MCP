import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { buildServer } from "../mcp/build-server.js";

const config = loadConfig(process.env);
const app = createApp({
  serverFactory: () => buildServer({ allowWrites: config.allowWrites }),
});

app.listen(config.port, () => {
  console.log(`listening on port ${config.port}, writes ${config.allowWrites ? "enabled" : "disabled"}`);
});
