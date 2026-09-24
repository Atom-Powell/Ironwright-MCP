import { loadGraphCredentials, loadStoreConnectionString } from "../config.js";
import { loadProfile } from "../domain/profile/load.js";
import { createGraphClient } from "../graph/client.js";
import { clientCredentialsTokenProvider, requireExactRoles, SERVER_TOKEN_ROLES } from "../graph/token.js";
import { createMemoryStateStore } from "../store/memory.js";
import { ensureTables, tableStateStoreFromConnectionString } from "../store/table.js";
import type { StateStore } from "../store/types.js";
import { formatScanResult, parseScanArguments, readProfile } from "./cli.js";
import { runScan } from "./run.js";

async function main(): Promise<void> {
  const args = parseScanArguments(process.argv.slice(2));
  const profile = loadProfile(await readProfile(args.profilePath));
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

  // The same guard the server runs behind: this command uses the server
  // application's own credentials, so a token carrying more than Sites.Selected
  // is refused here too, and the catch below prints why.
  const tokenProvider = requireExactRoles(clientCredentialsTokenProvider(credentials), SERVER_TOKEN_ROLES);
  const client = createGraphClient({ tokenProvider });
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
