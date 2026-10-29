import type { Request } from 'express';
import { USER_SETTINGS_PATH } from '../../../shared/paths.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { parseHostWithoutPort } from '../../../server/middleware/request-auth-helpers.js';
import { buildWorkerOriginPolicy } from './origin-policy.js';
import { isForeignLoopbackBrowserWrite } from './routes/SettingsRoutes.js';

// husni fork: the origins the operator names in CLAUDE_MEM_ALLOWED_ORIGINS (and
// CLAUDE_MEM_PUBLIC_URL) are the worker's own viewer, so My Work answers them as
// it answers loopback. Upstream keeps My Work on loopback alone, which leaves a
// worker reached through a tailnet or an HTTPS proxy with a viewer that answers
// 403 to everything it asks.

let configuredOrigins: string[] | null = null;

/** The configured viewer origins, read once like the Host check's policy: a change takes a restart. */
export function viewerOrigins(): string[] {
  configuredOrigins ??= buildWorkerOriginPolicy(SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)).allowedOrigins;
  return configuredOrigins;
}

/**
 * Whether a request was sent to the host name of a configured viewer origin.
 * A proxy in front of the worker (tailscale serve, an exe.dev integration)
 * connects from loopback and may add forwarding headers, so the name the
 * browser asked for is what identifies the viewer. The Host check runs first
 * and has already refused a name the operator did not trust.
 */
export function isViewerOriginHost(rawHost: string | undefined, origins: readonly string[]): boolean {
  if (!rawHost) return false;
  const host = parseHostWithoutPort(rawHost);
  return origins.some(origin => {
    try {
      return new URL(origin).hostname === host;
    } catch {
      return false;
    }
  });
}

/**
 * Whether a browser write or file open comes from a page other than the viewer:
 * upstream's localhost rule decides first, and a page it refuses is still the
 * viewer when its origin is a configured one. A request upstream admits (a hook
 * or the MCP server, which send no Origin) never reads the settings.
 */
export function isForeignViewerRequest(
  req: Pick<Request, 'headers'>,
  origins: () => readonly string[] = viewerOrigins,
): boolean {
  if (!isForeignLoopbackBrowserWrite(req)) return false;
  const origin = req.headers.origin;
  return !(typeof origin === 'string' && origins().includes(origin.trim().toLowerCase()));
}
