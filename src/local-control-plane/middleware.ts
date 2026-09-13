import type { IncomingMessage, ServerResponse } from "node:http";
import {
  beginTaskDispatch,
  localWorkerServiceRoleKey,
  serveChooseLocalAssetDirectory,
  serveEpisodeDeletion,
  serveEpisodeDeletionCleanup,
  serveEpisodeDispatch,
  serveEpisodePreflight,
  serveExternalConnectionTest,
  serveFreezeOpenChatCutStudio,
  serveGoldenProductionTest,
  serveLocalArtifact,
  serveLocalEpisodeDirectory,
  serveOpenLocalArtifact,
  serveOpenLocalAssetDirectory,
  serveOpenLocalEpisodeDirectory,
  serveOpenOpenChatCutStudio,
  serveProductionMaterial,
  servePublishPreparation,
  serveSystemStatus,
  serveTtsVoicePreview,
  serveWorkerPreflight,
  taskDispatchStatus,
  type TaskDispatchStatus,
} from "./routes/handlers";

export interface LocalControlPlaneOptions {
  supabasePublishableKey: string | undefined;
  supabaseUrl: string | undefined;
}

type Next = (error?: Error) => void;
export type LocalControlPlaneMiddleware = (request: IncomingMessage, response: ServerResponse, next: Next) => void;
type RouteHandler = (request: IncomingMessage, response: ServerResponse, next: Next) => void | Promise<void>;
type Route = readonly [path: string, handler: RouteHandler];

export interface LocalControlPlaneDependencies {
  dispatchTask?: (taskId: string) => "started" | "already_running";
  readTaskDispatchStatus?: (taskId: string) => TaskDispatchStatus;
  serviceRoleKey?: string;
}

interface RouteContext extends LocalControlPlaneOptions {
  dependencies: LocalControlPlaneDependencies;
  serviceRoleKey: string | undefined;
}

function localFileRoutes({ supabasePublishableKey, supabaseUrl }: RouteContext): readonly Route[] {
  return [
    ["/_local-artifact", serveLocalArtifact(supabaseUrl, supabasePublishableKey)],
    ["/_open-local-artifact", serveOpenLocalArtifact(supabaseUrl, supabasePublishableKey)],
    ["/_local-episode-directory", serveLocalEpisodeDirectory(supabaseUrl, supabasePublishableKey)],
    ["/_open-local-episode-directory", serveOpenLocalEpisodeDirectory(supabaseUrl, supabasePublishableKey)],
    ["/_choose-local-asset-directory", serveChooseLocalAssetDirectory(supabaseUrl, supabasePublishableKey)],
    ["/_open-local-asset-directory", serveOpenLocalAssetDirectory(supabaseUrl, supabasePublishableKey)],
  ];
}

function productionToolRoutes({ supabasePublishableKey, supabaseUrl }: RouteContext): readonly Route[] {
  return [
    ["/_production-material", serveProductionMaterial(supabaseUrl, supabasePublishableKey)],
    ["/_tts-voice-preview", serveTtsVoicePreview(supabaseUrl, supabasePublishableKey)],
    ["/_open-openchatcut-studio", serveOpenOpenChatCutStudio(supabaseUrl, supabasePublishableKey)],
    ["/_freeze-openchatcut-studio", serveFreezeOpenChatCutStudio(supabaseUrl, supabasePublishableKey)],
  ];
}

function runtimeEvidenceRoutes({ serviceRoleKey, supabasePublishableKey, supabaseUrl }: RouteContext): readonly Route[] {
  return [
    ["/_system-status", serveSystemStatus(supabaseUrl, supabasePublishableKey)],
    ["/_golden-production-test", serveGoldenProductionTest(supabaseUrl, supabasePublishableKey)],
    ["/_worker-preflight", serveWorkerPreflight(supabaseUrl, supabasePublishableKey)],
    ["/_episode-preflight", serveEpisodePreflight(supabaseUrl, supabasePublishableKey)],
    ["/_external-connection-test", serveExternalConnectionTest(supabaseUrl, supabasePublishableKey, serviceRoleKey)],
  ];
}

function operationRoutes({ dependencies, serviceRoleKey, supabasePublishableKey, supabaseUrl }: RouteContext): readonly Route[] {
  return [
    ["/_episode-dispatch", serveEpisodeDispatch(
      supabaseUrl,
      supabasePublishableKey,
      dependencies.dispatchTask ?? beginTaskDispatch,
      dependencies.readTaskDispatchStatus ?? taskDispatchStatus,
    )],
    ["/_publish-preparation", servePublishPreparation(supabaseUrl, supabasePublishableKey, serviceRoleKey)],
  ];
}

function deletionRoutes({ serviceRoleKey, supabasePublishableKey, supabaseUrl }: RouteContext): readonly Route[] {
  return [
    ["/_delete-episode", serveEpisodeDeletion(supabaseUrl, supabasePublishableKey, serviceRoleKey)],
    ["/_finalize-episode-deletion", serveEpisodeDeletionCleanup(supabaseUrl, supabasePublishableKey)],
  ];
}

function createRouteFamilies(
  options: LocalControlPlaneOptions,
  dependencies: LocalControlPlaneDependencies,
): readonly (readonly Route[])[] {
  const context: RouteContext = {
    ...options,
    dependencies,
    serviceRoleKey: dependencies.serviceRoleKey ?? localWorkerServiceRoleKey(),
  };
  return [
    localFileRoutes(context),
    productionToolRoutes(context),
    runtimeEvidenceRoutes(context),
    operationRoutes(context),
    deletionRoutes(context),
  ] satisfies readonly (readonly Route[])[];
}

export function createLocalControlPlaneMiddleware(
  options: LocalControlPlaneOptions,
  dependencies: LocalControlPlaneDependencies = {},
): LocalControlPlaneMiddleware {
  const routes = new Map(createRouteFamilies(options, dependencies).flat());
  return (request, response, next) => {
    const handler = routes.get(new URL(request.url ?? "", "http://127.0.0.1").pathname);
    if (!handler) {
      next();
      return;
    }
    try {
      void Promise.resolve(handler(request, response, next)).catch(next);
    } catch (error) {
      next(error instanceof Error ? error : new Error(String(error)));
    }
  };
}
