// tests/scripts/pre-eon/sitting-lib.test.ts
import { describe, expect, it } from "vitest";
import {
  judgeCampaign,
  judgeListPrecondition,
  parseBootstrapOutput,
  parseCampaignTable,
  parseProbeLines,
  redactSecrets,
  serverEnvironment,
  summaryMarkdown,
} from "../../../scripts/pre-eon/sitting-lib.js";
import { loadGrantedSiteUrl, loadGraphCredentials, loadInboundAuth } from "../../../src/config.js";
import { loadConfig } from "../../../src/server/config.js";
import { describeBootstrapSuccess } from "../../../src/setup/cli.js";

describe("the grant issuer's credentials", () => {
  it("are read out of the block the setup command really prints", () => {
    const printed = describeBootstrapSuccess({ appId: "11111111-2222-3333-4444-555555555555", secret: "s3cr~et.Value_8Q" });
    expect(parseBootstrapOutput(`To sign in, open the page and enter the code ABCD.\n${printed}\n`)).toEqual({
      clientId: "11111111-2222-3333-4444-555555555555",
      clientSecret: "s3cr~et.Value_8Q",
    });
  });

  it("are absent when the command printed no such block", () => {
    expect(parseBootstrapOutput("An application named Ironwright Grant Issuer already exists.")).toBeUndefined();
  });
});

describe("redaction of what the runner shows and logs", () => {
  it("replaces the value on a secret line whether or not the secret is known yet", () => {
    const printed = describeBootstrapSuccess({ appId: "app", secret: "s3cr~et.Value_8Q" });
    const shown = printed.split("\n").map((line) => redactSecrets(line, [])).join("\n");
    expect(shown).not.toContain("s3cr~et.Value_8Q");
    expect(shown).toContain("IW_BOOTSTRAP_CLIENT_SECRET=<kept in memory, not shown>");
    expect(shown).toContain("IW_BOOTSTRAP_CLIENT_ID=app");
  });

  it("replaces a known secret wherever it appears", () => {
    expect(redactSecrets("token request failed for secret abc123XYZ", ["abc123XYZ"])).toBe("token request failed for secret <secret>");
  });

  it("leaves a line alone when the only known secret is empty", () => {
    expect(redactSecrets("nothing to hide", [""])).toBe("nothing to hide");
  });
});

describe("the campaign table", () => {
  const table = [
    "",
    "| Scenario | Verdict | What happened |",
    "|---|---|---|",
    "| s1 implicit parent folder | MEASURED | Published deleted (204); save answered created |",
    "| s2 publication name case | PASS | uploaded 201 |",
    "| s3 executive summary | PASS | created |",
    "| s4 four concurrent opens | PASS | one item |",
    "| s5 six concurrent overwrites | PASS | one writer |",
    "| s6 hand edited state | MEASURED | refused |",
    "| s7 grant boundary | PASS | 403 |",
    "| s8 resume | PASS | rebuilt |",
    "",
    "full results: .superpowers/campaign/x.json",
  ].join("\n");

  it("is read into one row per scenario, keyed by the scenario's short name", () => {
    const rows = parseCampaignTable(table);
    expect(rows.map((row) => row.key)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"]);
    expect(rows[0]).toEqual({ key: "s1", verdict: "MEASURED", summary: "Published deleted (204); save answered created" });
  });

  it("passes when the two measured scenarios are measured and the other six pass", () => {
    expect(judgeCampaign(parseCampaignTable(table)).verdict).toBe("pass");
  });

  it("fails and names the scenario when one that should pass does not", () => {
    const result = judgeCampaign(parseCampaignTable(table.replace("| s4 four concurrent opens | PASS |", "| s4 four concurrent opens | FAIL |")));
    expect(result.verdict).toBe("fail");
    expect(result.detail).toContain("s4 FAIL");
  });

  it("fails when a scenario is missing, since a run that stopped early proves nothing about the rest", () => {
    const result = judgeCampaign(parseCampaignTable(table.split("\n").filter((line) => !line.startsWith("| s8")).join("\n")));
    expect(result.verdict).toBe("fail");
    expect(result.detail).toContain("s8 did not report");
  });
});

describe("the probe's list precondition lines", () => {
  const lines = (a: string, d: string): string =>
    ["R1   200  pass", "L3a  400  observed status 400, invalidRequest", `L4a  ${a}`, "L4b  200  pass", "L4c  200  pass", `L4d  ${d}`, "F4   200  pass"].join("\n");

  it("are read by step id with their status", () => {
    const parsed = parseProbeLines(lines("412  pass", "412  pass"));
    expect(parsed["L4a"]).toEqual({ status: 412, label: "pass" });
    expect(parsed["L3a"]).toEqual({ status: 400, label: "observed status 400, invalidRequest" });
  });

  it("read a 412 on the fields address as the precondition being enforced where the server writes", () => {
    const result = judgeListPrecondition(parseProbeLines(lines("412  pass", "412  pass")));
    expect(result.verdict).toBe("observed");
    expect(result.detail).toContain("enforced on the fields address");
  });

  it("read a 200 on fields with a 412 on the item as enforced on the item only", () => {
    const result = judgeListPrecondition(parseProbeLines(lines("200  observed 200: the stale If-Match was not enforced on this address", "412  pass")));
    expect(result.detail).toContain("enforced on the item, not on its fields");
  });

  it("read a 200 on both as no precondition at all", () => {
    const stale = "200  observed 200: the stale If-Match was not enforced on this address";
    expect(judgeListPrecondition(parseProbeLines(lines(stale, stale))).detail).toContain("not enforced on either address");
  });

  it("fail when the probe never reached the list precondition steps", () => {
    const result = judgeListPrecondition(parseProbeLines("R1   200  pass\nL1   403  FAIL expected 200, received 403"));
    expect(result.verdict).toBe("fail");
    expect(result.detail).toContain("did not reach L4a");
  });
});

describe("the environment the runner starts the server with", () => {
  // The first live run stopped here: the runner set the profile folder and the write switch and
  // nothing about inbound authentication, and the server refused to start without a key. The
  // environment is checked against the server's own loaders so that cannot recur unseen.
  const identity = { IW_TENANT_ID: "t", IW_CLIENT_ID: "c", IW_CLIENT_SECRET: "s", IW_SITE_URL: "https://contoso.sharepoint.com/sites/Example" };

  it("is accepted by every loader the server runs at startup", () => {
    const env = { ...identity, ...serverEnvironment("live", 3000) };
    expect(loadConfig(env)).toMatchObject({ port: 3000, allowWrites: true, profileDir: "profiles" });
    expect(loadInboundAuth(env).mode).toBe("none");
    expect(() => loadGraphCredentials(env)).not.toThrow();
    expect(loadGrantedSiteUrl(env)).toBe(identity.IW_SITE_URL);
  });

  it("asks for no inbound key because mode none binds loopback only, and says the operator meant it", () => {
    expect(serverEnvironment("live", 3000)).toMatchObject({ IW_INBOUND_AUTH: "none", IW_ALLOW_ANONYMOUS: "1" });
  });

  it("gives the simulator only its port", () => {
    expect(serverEnvironment("sim", 3939)).toEqual({ SIM_PORT: "3939" });
  });
});

describe("the summary", () => {
  it("is one table row per step, with the commit and the mode above it", () => {
    const md = summaryMarkdown({ startedAt: "2026-11-17T18:00:00.000Z", commit: "abc1234", mode: "live", folder: ".superpowers/sitting/x" }, [
      { step: "campaign", verdict: "pass", detail: "six pass, two measured" },
      { step: "interrupted open", verdict: "fail", detail: "two assessments | for one vendor" },
    ]);
    expect(md).toContain("Commit abc1234, mode live, started 2026-11-17T18:00:00.000Z.");
    expect(md).toContain("| campaign | pass | six pass, two measured |");
    // A pipe inside a detail would split the row.
    expect(md).toContain("| interrupted open | fail | two assessments / for one vendor |");
    expect(md).toContain("1 of 2 steps failed.");
  });
});
