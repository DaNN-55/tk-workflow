import { describe, expect, it } from "vitest";
import { registeredAdapters } from "./registeredAdapters";
import { createRuntimePreflight, type RuntimeEvidenceFact } from "./runtimePreflight";
import { credentialEnvironmentForReference } from "./runtimeEvidence";

describe("legacy Pexels connection references", () => {
  it("does not register an environment-variable fallback for Pexels", () => {
    expect(registeredAdapters.resolve({ capability: "b_roll_generation", provider: "pexels", adapter: "pexels_video" })).toMatchObject({ kind: "registered", choice: { connection: { kind: "owner_managed" } } });
    expect(credentialEnvironmentForReference("pexels", "pexels_video", "pexels-default")).toBeUndefined();
  });

  it("blocks a frozen pexels-default reference as blueprint repair", async () => {
    const preflight = createRuntimePreflight({ collect: async ({ demands }) => demands.map((demand) => ({ ...demand, state: "not_applicable" }) as RuntimeEvidenceFact) });
    const decision = await preflight.inspect({
      kind: "account_blueprint",
      target: "existing_episode",
      requiredMediaCapabilities: ["b_roll_generation"],
      policy: { b_roll: { allowed_tools: ["read", "write"], credential_ref: "pexels-default", executor: { adapter: "pexels_video", model: "pexels-video-v1", prompt_version: "b-roll-v1", provider: "pexels" } } },
    });

    expect(decision.report.checks).toContainEqual(expect.objectContaining({
      action: "edit_blueprint",
      check: "blueprint_configuration",
      scope: "blueprint",
      status: "blocked",
    }));
  });
});
