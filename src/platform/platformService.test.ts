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

  it("creates an episode waiting for explicit production input", async () => {
    const platform = createPlatformService(createInMemoryPlatformRepository());

    const episode = await platform.createEpisode({
      accountId: "account-2",
      blueprintVersionId: "blueprint-4",
      title: "A new series entry",
    });

    expect(episode).toMatchObject({
      accountId: "account-2",
      blueprintVersionId: "blueprint-4",
      status: "waiting_input",
      title: "A new series entry",
    });
    expect(await platform.listTasks(episode.id)).toEqual([]);
  });

  it("creates an untitled episode with an optional fixed series version", async () => {
    const platform = createPlatformService(createInMemoryPlatformRepository());

    const episode = await platform.createEpisode({
      accountId: "account-2",
      blueprintVersionId: "blueprint-4",
      seriesVersionId: "series-version-3",
      title: "",
    });

    expect(episode).toMatchObject({
      accountId: "account-2",
      blueprintVersionId: "blueprint-4",
      seriesVersionId: "series-version-3",
      status: "waiting_input",
      title: "",
    });
  });

  it("imports a main script as an immutable material revision", async () => {
    const platform = createPlatformService(createInMemoryPlatformRepository());
    const episode = await platform.createEpisode({
      accountId: "account-2",
      blueprintVersionId: "blueprint-4",
      title: "",
    });
    const sourceContent = new TextEncoder().encode("First script");

    const revision = await platform.importMaterial({
      content: sourceContent,
      episodeId: episode.id,
      isMainScript: true,
      materialType: "script",
      mimeType: "text/plain",
      sourceKind: "directory",
      sourcePath: "inbox/script.txt",
    });
    sourceContent.fill(0);

    expect(revision).toMatchObject({
      episodeId: episode.id,
      fileSize: 12,
      isMainScript: true,
      sha256: "6c9b61c88d4a2f2a053a90540e861226ed0b1ca25396acedf22ef3f5453c1d62",
      sourceKind: "directory",
      sourcePath: "inbox/script.txt",
    });
    expect(new TextDecoder().decode((await platform.listMaterialRevisions(episode.id))[0]?.content)).toBe("First script");
    expect(await platform.listEpisodes()).toContainEqual(expect.objectContaining({ id: episode.id, status: "script_approved" }));
  });

  it("updates episode title without invalidating imported content", async () => {
    const platform = createPlatformService(createInMemoryPlatformRepository());
    const episode = await platform.createEpisode({
      accountId: "account-2",
      blueprintVersionId: "blueprint-4",
      title: "",
    });
    const revision = await platform.importMaterial({
      content: new TextEncoder().encode("Approved source"),
      episodeId: episode.id,
      isMainScript: true,
      materialType: "script",
      mimeType: "text/plain",
      sourceKind: "paste",
      sourcePath: "pasted-script.txt",
    });

    const renamed = await platform.updateEpisodeTitle(episode.id, "A title chosen later");

    expect(renamed.title).toBe("A title chosen later");
    expect(await platform.listMaterialRevisions(episode.id)).toContainEqual(revision);
  });

  it("lists episodes by fixed series version with their coarse production stage", async () => {
    const platform = createPlatformService(createInMemoryPlatformRepository());
    await platform.createEpisode({ accountId: "account-2", blueprintVersionId: "blueprint-4", seriesVersionId: "series-version-1", title: "First" });
    const matchingEpisode = await platform.createEpisode({ accountId: "account-2", blueprintVersionId: "blueprint-4", seriesVersionId: "series-version-2", title: "Second" });
    await platform.createEpisode({ accountId: "account-2", blueprintVersionId: "blueprint-4", title: "Standalone" });

    expect(await platform.listEpisodes({ seriesVersionId: "series-version-2" })).toEqual([
      expect.objectContaining({ id: matchingEpisode.id, status: "waiting_input" }),
    ]);
  });
});
