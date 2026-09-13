import {
  createLocalControlPlaneMiddleware as createMiddleware,
  type LocalControlPlaneMiddleware,
  type LocalControlPlaneOptions,
} from "./middleware";

export type { LocalControlPlaneMiddleware, LocalControlPlaneOptions };

export function createLocalControlPlaneMiddleware(options: LocalControlPlaneOptions): LocalControlPlaneMiddleware {
  return createMiddleware(options);
}
