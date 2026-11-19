import express from "express";
import { createApp } from "../../src/server/app.js";
import { buildServer, type ToolCallRecord } from "../../src/mcp/build-server.js";
import { assessmentModule } from "../../src/modules/assessment/index.js";
import { SERVER_VERSION } from "../../src/version.js";
import type { JournalEntry } from "../../src/store/types.js";
import type { SimDeployment } from "./deployment.js";
import { readJournal } from "../../src/tools/assessment/journal.js";

export const SIM_NOTICE = "Simulated tenant. Nothing here reached Microsoft 365, and nothing here shows how Microsoft Graph behaves.";

/** Everything the simulated tenant holds, for a person to read between tool calls. */
export async function simState(deployment: SimDeployment): Promise<Record<string, unknown>> {
  const { sim, context, profile } = deployment;
  const lists: Record<string, unknown> = {};
  const names = [profile.lists.vendors.name, profile.lists.assessments.name, profile.lists.findings.name, ...(profile.lists.journal === undefined ? [] : [profile.lists.journal.name])];
  for (const name of names) lists[name] = sim.listItems(name);

  // The journal is keyed by assessment id, the writes an open makes before the id is written included.
  const idColumn = profile.lists.assessments.columns.assessmentId;
  const keys = [...sim.listItems(profile.lists.assessments.name).flatMap((item) => (typeof item.fields[idColumn] === "string" ? [item.fields[idColumn]] : []))];
  const journal: Record<string, JournalEntry[]> = {};
  for (const key of keys) {
    // Through the journal's own reader, so a profile that keeps it in a list is shown from the list.
    const entries = await readJournal(context, { profile, siteId: sim.siteId, driveId: sim.driveId, correlationId: "sim-state", now: context.now() }, key);
    if (entries.length > 0) journal[key] = entries;
  }
  return { notice: SIM_NOTICE, profileId: profile.profileId, lists, library: sim.tree(), journal };
}

/**
 * The real server application over the simulated tenant, with a few routes in
 * front of it that stand in for what happens outside the server: a publisher
 * writing the publication, an operator editing a list item, a person looking
 * at the site. Those routes are under /sim and are not part of the product.
 *
 * Only the assessment module's tools are registered. The simulated tenant
 * answers nothing the compliance tools send, and offering a tool that can
 * only fail would be a tool list that does not describe the server.
 */
export function createSimApp(deployment: SimDeployment, onToolCall?: (record: ToolCallRecord) => void): express.Express {
  const { sim, context } = deployment;
  const outer = express();

  outer.get("/sim/state", (_req, res, next) => {
    simState(deployment).then((state) => res.status(200).json(state), next);
  });

  const filePath = (req: express.Request): string => {
    const parts = (req.params as { path?: string[] | string }).path;
    return Array.isArray(parts) ? parts.join("/") : (parts ?? "");
  };

  outer.put("/sim/files/*path", express.raw({ type: () => true, limit: "4mb" }), (req, res) => {
    const body: unknown = req.body;
    const bytes = body instanceof Uint8Array ? new Uint8Array(body) : new Uint8Array();
    try {
      sim.putFile(filePath(req), bytes);
      res.status(200).json({ put: filePath(req), bytes: bytes.byteLength });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  outer.delete("/sim/files/*path", (req, res) => {
    sim.removeItem(filePath(req));
    res.status(200).json({ removed: filePath(req) });
  });

  outer.patch("/sim/lists/:list/:id", express.json(), (req, res) => {
    try {
      sim.setListItemFields(req.params.list, req.params.id, (req.body ?? {}) as Record<string, unknown>);
      res.status(200).json({ list: req.params.list, id: req.params.id, set: req.body as unknown });
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  outer.use(
    createApp({
      auth: { mode: "none", header: "x-api-key" },
      version: SERVER_VERSION,
      serverFactory: () => buildServer({ allowWrites: true, context, tools: assessmentModule.tools, ...(onToolCall === undefined ? {} : { onToolCall }) }),
    }),
  );
  return outer;
}
