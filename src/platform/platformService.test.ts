import { describe, expect, it } from "vitest";
import { createInMemoryPlatformRepository } from "./inMemoryRepository";
import { createPlatformService, InvalidTransitionError } from "./platformService";

describe("platform service", () => {
  it("allows an owner to approve a script and records the audit event", async () => {
    const repository = createInMemoryPlatformRepository();
    const platform = createPlatformService(repository);
    const episode = await platform.createEpisode({
      accountId: "account-1",
      blueprintVersionId: "blueprint-1",
      title: "The first signal",
    });

    await platform.transitionEpisode({
      episodeId: episode.id,
      actor: { id: "worker-1", role: "worker" },
      to: "script_draft",
      reason: "Brief is ready for drafting",
    });
    await platform.transitionEpisode({
      episodeId: episode.id,
      actor: { id: "worker-1", role: "worker" },
      to: "script_review",
      reason: "Script is ready for review",
    });

    const approved = await platform.transitionEpisode({
      episodeId: episode.id,
      actor: { id: "owner-1", role: "owner" },
      to: "script_approved",
      reason: "Approved for visual work",
    });

    expect(approved.status).toBe("script_approved");
    expect(await platform.listAuditEvents(episode.id)).toContainEqual(
      expect.objectContaining({
        actorId: "owner-1",
        from: "script_review",
        to: "script_approved",
      }),
    );
  });

  it("rejects an invalid transition instead of silently skipping review gates", async () => {
    const platform = createPlatformService(createInMemoryPlatformRepository());
    const episode = await platform.createEpisode({
      accountId: "account-1",
      blueprintVersionId: "blueprint-1",
      title: "A guarded episode",
    });

    await expect(
      platform.transitionEpisode({
        episodeId: episode.id,
        actor: { id: "owner-1", role: "owner" },
        to: "render_ready",
        reason: "Try to skip review",
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("creates an episode with its blueprint snapshot and first task", async () => {
    const platform = createPlatformService(createInMemoryPlatformRepository());

    const episode = await platform.createEpisode({
      accountId: "account-2",
      blueprintVersionId: "blueprint-4",
      title: "A new series entry",
    });

    expect(episode).toMatchObject({
      accountId: "account-2",
      blueprintVersionId: "blueprint-4",
      status: "brief_draft",
      title: "A new series entry",
    });
    expect(await platform.listTasks(episode.id)).toContainEqual(
      expect.objectContaining({ type: "draft_brief", status: "ready" }),
    );
  });
});
