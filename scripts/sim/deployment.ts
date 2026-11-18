import { readFileSync } from "node:fs";
import { createSimTenant, type SimTenant } from "./tenant.js";
import { createProfileRegistry } from "../../src/profiles/registry.js";
import { isAssessmentProfile } from "../../src/domain/profile/library.js";
import type { AssessmentProfile } from "../../src/domain/profile/assessment.js";
import { createMemoryStateStore } from "../../src/store/memory.js";
import { createScanCoordinator } from "../../src/scan/coordinator.js";
import type { ToolContext } from "../../src/tools/context.js";

export const SIM_PROFILE_PATH = "examples/profiles/assessment-example.json";

export interface SimDeploymentOptions {
  /** A profile file to run under; defaults to the committed assessment example. */
  profilePath?: string;
  listFilterIgnoresCase?: boolean;
  latencyMs?: number;
  now?: () => Date;
}

export interface SimDeployment {
  sim: SimTenant;
  /** The context the real server builds, with the simulated tenant where the Graph client goes. */
  context: ToolContext;
  profile: AssessmentProfile;
}

/**
 * Everything the server builds at startup, with one substitution: the Graph
 * client is the simulated tenant. The profile is loaded and validated by the
 * real registry, the store is the real in-memory store, and the tools are the
 * real handlers, so a run here differs from a deployment only in who answers
 * the Graph requests. The tenant's lists and their columns are taken from the
 * profile, which is what an operator's preparation of the site amounts to.
 */
export function createSimDeployment(options: SimDeploymentOptions = {}): SimDeployment {
  const path = options.profilePath ?? SIM_PROFILE_PATH;
  const contents = JSON.parse(readFileSync(path, "utf8")) as { sites?: { siteUrl?: unknown }[]; identity?: { siteUrl?: unknown } };
  const siteUrl = contents.sites?.[0]?.siteUrl ?? contents.identity?.siteUrl;
  if (typeof siteUrl !== "string") throw new Error(`The profile at ${path} names no site URL.`);

  const profiles = createProfileRegistry([{ source: path, contents }], siteUrl);
  const profile = profiles.getAny(profiles.ids()[0]!);
  if (!isAssessmentProfile(profile)) throw new Error(`The profile at ${path} is not an assessment profile, and the simulated tenant answers only the assessment module.`);

  const now = options.now ?? ((): Date => new Date());
  const sim = createSimTenant({
    siteUrl,
    library: profile.identity.library,
    lists: {
      [profile.lists.vendors.name]: Object.values(profile.lists.vendors.columns),
      [profile.lists.assessments.name]: Object.values(profile.lists.assessments.columns),
      [profile.lists.findings.name]: Object.values(profile.lists.findings.columns),
    },
    ...(options.listFilterIgnoresCase === undefined ? {} : { listFilterIgnoresCase: options.listFilterIgnoresCase }),
    ...(options.latencyMs === undefined ? {} : { latencyMs: options.latencyMs }),
    now,
  });

  const store = createMemoryStateStore();
  const context: ToolContext = {
    profiles,
    graph: sim.graph,
    store,
    scans: createScanCoordinator({ client: sim.graph, store, now }),
    now,
    grantedSiteUrl: siteUrl,
  };
  return { sim, context, profile };
}
