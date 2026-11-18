import { runWalkthrough } from "./walkthrough.js";

/** npm run sim:walkthrough. See docs/SIMULATOR.md. */
runWalkthrough((line) => console.log(line)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
