import { describe, expect, it } from "vitest";
import { createSimTenant, type SimTenant } from "../../../scripts/sim/tenant.js";
import { GraphRequestError } from "../../../src/graph/errors.js";
import { resolveDrive } from "../../../src/graph/drive.js";
import { downloadDriveItem } from "../../../src/graph/content.js";
import { createFile, createFolder, overwriteFile, readDriveItem } from "../../../src/graph/items.js";
import { createListItem, getListItem, listItemsPath, queryListItems, updateListItemFields } from "../../../src/graph/lists.js";

const SITE_URL = "https://contoso.sharepoint.com/sites/Example";
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function tenant(overrides: Partial<Parameters<typeof createSimTenant>[0]> = {}): SimTenant {
  return createSimTenant({ siteUrl: SITE_URL, library: "Documents", lists: { Vendors: ["FolderName"], Assessments: ["AssessmentId", "Status"] }, ...overrides });
}

async function refusal(run: () => Promise<unknown>): Promise<GraphRequestError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof GraphRequestError) return error;
    throw error;
  }
  throw new Error("the request was answered, but a Graph refusal was expected");
}

// Every request below is built by the server's own Graph helpers, so the simulated tenant is
// exercised through the exact URLs, headers and bodies the server sends.
describe("the simulated tenant: site and library", () => {
  it("resolves the site by its URL and the library by its name", async () => {
    const sim = tenant();
    const location = await resolveDrive(sim.graph, SITE_URL, "Documents");
    expect(location).toMatchObject({ siteId: sim.siteId, driveId: sim.driveId });
    expect(sim.graph.requests()).toBe(2);
  });

  it("answers 404 for a site URL other than its own", async () => {
    const error = await refusal(() => resolveDrive(tenant().graph, "https://contoso.sharepoint.com/sites/Other", "Documents"));
    expect(error.status).toBe(404);
  });
});

describe("the simulated tenant: lists, as probes L1 to L3 measured them on 2026-11-07", () => {
  it("creates items with integer ids rendered as strings, counting up and never reused (L2a)", async () => {
    const sim = tenant();
    const first = await createListItem(sim.graph, { siteId: sim.siteId, listName: "Vendors", fields: { Title: "Acme Corp", FolderName: "Acme Corp" } });
    const second = await createListItem(sim.graph, { siteId: sim.siteId, listName: "Vendors", fields: { Title: "Globex" } });
    expect([first.id, second.id]).toEqual(["1", "2"]);
    expect(first.fields).toMatchObject({ id: "1", Title: "Acme Corp", FolderName: "Acme Corp" });
    expect(first.eTag).toMatch(/^"[0-9a-f-]+,1"$/);
  });

  it("refuses a filtered query without the non indexed header with 400 invalidRequest, and answers it with the header (L3a, L3b)", async () => {
    const sim = tenant();
    await createListItem(sim.graph, { siteId: sim.siteId, listName: "Vendors", fields: { Title: "Acme Corp" } });
    const url = `${listItemsPath(sim.siteId, "Vendors")}?$expand=fields&$filter=${encodeURIComponent("fields/Title eq 'Acme Corp'")}`;

    const error = await refusal(() => sim.graph.get(url));
    expect([error.status, error.code]).toEqual([400, "invalidRequest"]);

    const found = await queryListItems(sim.graph, { siteId: sim.siteId, listName: "Vendors", filter: "fields/Title eq 'Acme Corp'" });
    expect(found.map((item) => item.id)).toEqual(["1"]);
  });

  it("matches every clause of a filter joined by and, with a doubled quote read as one", async () => {
    const sim = tenant();
    const site = { siteId: sim.siteId, listName: "Assessments" };
    await createListItem(sim.graph, { ...site, fields: { Title: "O'Brien and Sons", Status: "In Progress" } });
    await createListItem(sim.graph, { ...site, fields: { Title: "O'Brien and Sons", Status: "Completed" } });

    const found = await queryListItems(sim.graph, { ...site, filter: "fields/Title eq 'O''Brien and Sons' and fields/Status eq 'Completed'" });
    expect(found.map((item) => item.id)).toEqual(["2"]);
  });

  it("answers a fields update with the whole fields object and a new ETag version (L2b)", async () => {
    const sim = tenant();
    const site = { siteId: sim.siteId, listName: "Assessments" };
    const created = await createListItem(sim.graph, { ...site, fields: { Title: "Acme Corp", Status: "In Progress" } });

    const fields = await updateListItemFields(sim.graph, { ...site, itemId: created.id, fields: { Status: "Completed" } });
    expect(fields).toMatchObject({ id: "1", Title: "Acme Corp", Status: "Completed" });

    const back = await getListItem(sim.graph, { ...site, itemId: created.id });
    expect(back?.eTag).toMatch(/,2"$/);
    expect(back?.fields.Status).toBe("Completed");
  });

  it("keeps a multi line value exactly as sent (the 9c sitting, 2026-11-08)", async () => {
    const sim = tenant({ lists: { Findings: ["Observation"] } });
    const text = "First paragraph.\n\nSecond paragraph.";
    const created = await createListItem(sim.graph, { siteId: sim.siteId, listName: "Findings", fields: { Title: "F-1", Observation: text } });
    expect(created.fields.Observation).toBe(text);
  });

  it("pages a query past $top with a next link the server's own paging follows", async () => {
    const sim = tenant();
    const site = { siteId: sim.siteId, listName: "Assessments" };
    for (let index = 0; index < 5; index += 1) await createListItem(sim.graph, { ...site, fields: { Title: "Acme Corp", Status: "Completed" } });
    const before = sim.graph.requests();

    const found = await queryListItems(sim.graph, { ...site, filter: "fields/Status eq 'Completed'", top: 2 });

    expect(found.map((item) => item.id)).toEqual(["1", "2", "3", "4", "5"]);
    expect(sim.graph.requests() - before).toBe(3);
  });

  it("answers 404 for an item id the list does not hold", async () => {
    const sim = tenant();
    expect(await getListItem(sim.graph, { siteId: sim.siteId, listName: "Vendors", itemId: "9" })).toBeUndefined();
  });

  it("refuses a column the list does not have, on a write and in a filter", async () => {
    // Modeled, not measured: the status and code are what Graph documents for an unknown field.
    const sim = tenant();
    const site = { siteId: sim.siteId, listName: "Vendors" };
    expect((await refusal(() => createListItem(sim.graph, { ...site, fields: { Title: "Acme Corp", Folder: "x" } }))).status).toBe(400);
    expect((await refusal(() => queryListItems(sim.graph, { ...site, filter: "fields/Folder eq 'x'" }))).status).toBe(400);
  });

  it("matches a filter value without regard to case by default, and exactly when told to", async () => {
    // Not measured for lists; the option exists so both readings can be run.
    for (const [ignoresCase, expected] of [[true, ["1"]], [false, []]] as const) {
      const sim = tenant({ listFilterIgnoresCase: ignoresCase });
      const site = { siteId: sim.siteId, listName: "Vendors" };
      await createListItem(sim.graph, { ...site, fields: { Title: "Acme Corp" } });
      const found = await queryListItems(sim.graph, { ...site, filter: "fields/Title eq 'ACME CORP'" });
      expect(found.map((item) => item.id)).toEqual(expected);
    }
  });
});

describe("the simulated tenant: the drive, as probes F0 to F3 measured it on 2026-11-07", () => {
  it("creates a folder, and answers a second create of the name with 409 nameAlreadyExists (F0, F1b)", async () => {
    const sim = tenant();
    const first = await createFolder(sim.graph, { driveId: sim.driveId, parentPath: "", name: "Assessments" });
    const again = await createFolder(sim.graph, { driveId: sim.driveId, parentPath: "", name: "Assessments" });
    const nested = await createFolder(sim.graph, { driveId: sim.driveId, parentPath: "Assessments", name: "Acme Corp" });
    expect([first.kind, again.kind, nested.kind]).toEqual(["created", "already_exists", "created"]);
    expect(sim.tree()).toEqual([
      { path: "Assessments", kind: "folder", size: 0 },
      { path: "Assessments/Acme Corp", kind: "folder", size: 0 },
    ]);
  });

  it("creates a file under conflictBehavior fail, and refuses an occupied name with 409 (F2a, F2b)", async () => {
    const sim = tenant();
    const target = { driveId: sim.driveId, path: "notes.md", bytes: bytes("one"), contentType: "text/markdown" };
    const first = await createFile(sim.graph, target);
    const second = await createFile(sim.graph, { ...target, bytes: bytes("two") });
    expect([first.kind, second.kind]).toEqual(["created", "name_conflict"]);
    expect(new TextDecoder().decode(await downloadDriveItem(sim.graph, { driveId: sim.driveId, workbookPath: "notes.md" }))).toBe("one");
  });

  it("overwrites under a current If-Match, and answers a stale one with 412 (F3a, F3b)", async () => {
    const sim = tenant();
    const target = { driveId: sim.driveId, path: "notes.md", bytes: bytes("one"), contentType: "text/markdown" };
    const created = await createFile(sim.graph, target);
    if (created.kind !== "created") throw new Error("expected a create");
    const etag = created.item.eTag!;

    const overwritten = await overwriteFile(sim.graph, { ...target, bytes: bytes("two"), etag });
    const stale = await overwriteFile(sim.graph, { ...target, bytes: bytes("three"), etag });

    expect([overwritten.kind, stale.kind]).toEqual(["overwritten", "precondition_failed"]);
    expect(overwritten.kind === "overwritten" && overwritten.item.eTag).not.toBe(etag);
    expect(new TextDecoder().decode(await downloadDriveItem(sim.graph, { driveId: sim.driveId, workbookPath: "notes.md" }))).toBe("two");
  });

  it("creates the file when a PUT under If-Match addresses a path holding nothing (F3c)", async () => {
    const sim = tenant();
    const outcome = await overwriteFile(sim.graph, { driveId: sim.driveId, path: "ghost.md", bytes: bytes("x"), contentType: "text/markdown", etag: '"{NONE},1"' });
    expect(outcome.kind).toBe("overwritten");
    expect(sim.tree()).toEqual([{ path: "ghost.md", kind: "file", size: 1 }]);
  });

  it("looks a path up without regard to case and answers the stored name (the campaign, 2026-11-09)", async () => {
    const sim = tenant();
    sim.putFile("Published/acme_report.docx", bytes("docx"));
    const lookup = await readDriveItem(sim.graph, { driveId: sim.driveId, path: "published/ACME_Report.docx" });
    expect(lookup.kind === "found" && lookup.item.name).toBe("acme_report.docx");
    expect(lookup.kind === "found" && lookup.item.isFolder).toBe(false);
  });

  it("creates a missing parent folder on a content PUT (the campaign, 2026-11-09)", async () => {
    const sim = tenant();
    await createFile(sim.graph, { driveId: sim.driveId, path: "Published/summary.md", bytes: bytes("s"), contentType: "text/markdown" });
    expect(sim.tree().map((entry) => entry.path)).toEqual(["Published", "Published/summary.md"]);
  });

  it("answers 404 itemNotFound for a path holding nothing", async () => {
    const sim = tenant();
    expect(await readDriveItem(sim.graph, { driveId: sim.driveId, path: "nothing/here.md" })).toEqual({ kind: "not_found" });
  });

  it("refuses a name holding a character SharePoint does not allow", async () => {
    // Modeled on SharePoint's published name rules; the status and code were not measured.
    const sim = tenant();
    const error = await refusal(() => createFile(sim.graph, { driveId: sim.driveId, path: "Acme: Cloud.md", bytes: bytes("x"), contentType: "text/markdown" }));
    expect(error.status).toBe(400);
    expect(sim.tree()).toEqual([]);
  });

  it("counts a content download as two requests, the redirect included, as the real client does", async () => {
    const sim = tenant();
    sim.putFile("notes.md", bytes("one"));
    const before = sim.graph.requests();
    await downloadDriveItem(sim.graph, { driveId: sim.driveId, workbookPath: "notes.md" });
    expect(sim.graph.requests() - before).toBe(2);
  });
});

describe("the simulated tenant: what is not Graph", () => {
  it("lets a test stand in for a person: put a file, remove an item, edit a list item", async () => {
    const sim = tenant();
    sim.putFile("A/B/file.txt", bytes("abc"));
    expect(sim.tree()).toEqual([
      { path: "A", kind: "folder", size: 0 },
      { path: "A/B", kind: "folder", size: 0 },
      { path: "A/B/file.txt", kind: "file", size: 3 },
    ]);
    sim.removeItem("A/B");
    expect(sim.tree()).toEqual([{ path: "A", kind: "folder", size: 0 }]);

    const created = await createListItem(sim.graph, { siteId: sim.siteId, listName: "Assessments", fields: { Title: "Acme Corp", Status: "In Progress" } });
    sim.setListItemFields("Assessments", created.id, { Status: "Completed" });
    expect(sim.listItems("Assessments")).toEqual([{ id: "1", fields: { Title: "Acme Corp", Status: "Completed" } }]);
  });

  it("fails the next matching request once when told to, then answers normally", async () => {
    const sim = tenant();
    sim.failNext({ method: "POST", pathIncludes: "/lists/Vendors/items", status: 503, code: "serviceNotAvailable" });
    const site = { siteId: sim.siteId, listName: "Vendors" };
    expect((await refusal(() => createListItem(sim.graph, { ...site, fields: { Title: "Acme Corp" } }))).status).toBe(503);
    expect((await createListItem(sim.graph, { ...site, fields: { Title: "Acme Corp" } })).id).toBe("1");
  });

  it("says so when a request reaches something it does not simulate, rather than answering plausibly", async () => {
    const sim = tenant();
    await expect(sim.graph.get(`/drives/${sim.driveId}/root/delta`)).rejects.toThrow(/does not simulate GET/);
    await expect(sim.graph.post("/search/query", {})).rejects.toThrow(/does not simulate POST/);
  });
});
