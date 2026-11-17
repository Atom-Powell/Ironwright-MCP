import { createSimApp, SIM_NOTICE } from "./app.js";
import { formatToolCallRecord } from "../../src/mcp/build-server.js";
import { createSimDeployment, SIM_PROFILE_PATH } from "./deployment.js";

/**
 * npm run sim. Starts the real server application over a simulated tenant, on
 * loopback only and with no inbound authentication, for a person to drive the
 * assessment tools without a tenant. See docs/SIMULATOR.md.
 *
 *   SIM_PORT      default 3939
 *   SIM_PROFILE   an assessment profile file, default examples/profiles/assessment-example.json
 *
 * Everything is held in memory and is gone when the process stops.
 */
function main(): void {
  const portText = process.env.SIM_PORT ?? "3939";
  const port = /^\d+$/.test(portText) ? Number.parseInt(portText, 10) : Number.NaN;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`SIM_PORT must be an integer between 1 and 65535, received "${portText}".`);
    process.exitCode = 1;
    return;
  }
  const profilePath = process.env.SIM_PROFILE?.trim() || SIM_PROFILE_PATH;
  const deployment = createSimDeployment({ profilePath });
  // The same line per tool call the real server writes, so a session here reads like its log.
  const app = createSimApp(deployment, (record) => console.log(formatToolCallRecord(record)));

  const server = app.listen(port, "127.0.0.1", () => {
    if (!server.listening) return;
    const base = `http://127.0.0.1:${port}`;
    console.log(SIM_NOTICE);
    console.log(`Profile "${deployment.profile.profileId}" from ${profilePath}.`);
    console.log(`MCP endpoint:   POST ${base}/mcp   (no key; loopback only)`);
    console.log(`Site contents:  GET  ${base}/sim/state`);
    console.log(`Put a file as a publisher would:   curl -X PUT --data-binary @file.docx "${base}/sim/files/<library path>"`);
    console.log(`Remove a file or folder:           curl -X DELETE "${base}/sim/files/<library path>"`);
    console.log(`Edit a list item by hand:          curl -X PATCH -H "content-type: application/json" -d '{"Status":"Completed"}' "${base}/sim/lists/Assessments/1"`);
  });
  server.on("error", (error: Error) => {
    if (server.listening) return;
    console.error(`the simulated server could not listen on port ${port}: ${error.message}`);
    process.exitCode = 1;
  });
}

main();
