import { readFile } from "node:fs/promises";
import { loadGraphCredentials, loadStoreConnectionString } from "../config.js";
import { loadProfile } from "../domain/profile/load.js";
import { createGraphClient } from "../graph/client.js";
import { clientCredentialsTokenProvider } from "../graph/token.js";
import { createMemoryStateStore } from "../store/memory.js";
import { ensureTables, tableStateStoreFromConnectionString } from "../store/table.js";
import type { StateStore } from "../store/types.js";
import { formatScanResult, parseScanArguments } from "./cli.js";
import { runScan } from "./run.js";

async function main(): Promise<void> {
  const args = parseScanArguments(process.argv.slice(2));
  const profile = loadProfile(JSON.parse(await readFile(args.profilePath, "utf8")));
  const credentials = loadGraphCredentials(process.env);
  const connectionString = loadStoreConnectionString(process.env);

  let store: StateStore;
  let storeKind: "azure-table" | "in-memory";
  if (connectionString === undefined) {
    store = createMemoryStateStore();
    storeKind = "in-memory";
  } else {
    const table = tableStateStoreFromConnectionString(connectionString);
    await ensureTables(table.clients);
    store = table.store;
    storeKind = "azure-table";
  }

  const client = createGraphClient({ tokenProvider: clientCredentialsTokenProvider(credentials) });
  const result = await runScan({
    client,
    store,
    profile,
    now: () => new Date(),
    ...(args.subPath === undefined ? {} : { subPath: args.subPath }),
  });

  for (const line of formatScanResult(result, storeKind)) console.log(line);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
