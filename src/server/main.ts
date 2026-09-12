import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig(process.env);
const app = createApp();

app.listen(config.port, () => {
  console.log(`listening on port ${config.port}, writes ${config.allowWrites ? "enabled" : "disabled"}`);
});
