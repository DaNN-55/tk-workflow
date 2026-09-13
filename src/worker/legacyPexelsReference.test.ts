import { describe, expect, it } from "vitest";
import { registeredAdapters } from "./registeredAdapters";
import { createRuntimePreflight, credentialEnvironmentForReference, runtimeCapabilitiesFromBlueprintPolicy } from "./runtimePreflight";

describe("legacy Pexels connection references", () => {
  it("does not register an environment-variable fallback for Pexels", () => {
    expect(registeredAdapters.resolve({ capability: "b_roll_generation", provider: "pexels", adapter: "pexels_video" })).toMatchObject({ kind: "registered", choice: { connection: { kind: "owner_managed" } } });
    expect(credentialEnvironmentForReference("pexels", "pexels_video", "pexels-default")).toBeUndefined();
  });

  it("blocks a frozen pexels-default reference as blueprint repair", () => {
    const [capability] = runtimeCapabilitiesFromBlueprintPolicy({
      b_roll: {
        allowed_tools: ["read", "write"],
        credential_ref: "pexels-default",
        executor: { adapter: "pexels_video", model: "pexels-video-v1", prompt_version: "b-roll-v1", provider: "pexels" },
      },
    }).filter((candidate) => candidate.capability === "b_roll_generation");

    expect(createRuntimePreflight([capability!]).checks).toContainEqual(expect.objectContaining({
      action: "edit_blueprint",
      check: "blueprint_configuration",
      scope: "blueprint",
      status: "blocked",
    }));
  });
});
