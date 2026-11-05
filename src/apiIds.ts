import * as path from 'path';

/**
 * URL ids for the control API. Both sessions (VS Code windows) and solutions
 * (loaded .sln files) are addressed by a sanitized, lowercase segment. The
 * mapping is intentionally lossy and stable: the same input always yields the
 * same id, and ids are unique within their scope via {@link assignUniqueId}.
 */

/** Top-level path segments the API reserves, so a session/solution id can never shadow a route. */
const RESERVED_IDS = new Set(['api', 'internal', 'index.html', 'sessions', 'runs', 'favicon.ico']);

export function sanitizeApiId(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'unnamed';
}

/**
 * Derive the proposed session id from the window's workspace. The first folder
 * wins (multi-root and .code-workspace files both expose folders); an empty
 * window falls back to the workspace file name, then to "untitled".
 */
export function deriveSessionBaseId(
  workspaceFile: { fsPath: string } | undefined,
  folders: readonly { name: string }[] | undefined
): string {
  const sanitize = (value: string) => withReservedGuard(sanitizeApiId(value));
  if (folders && folders.length > 0) {
    return sanitize(folders[0].name);
  }
  if (workspaceFile) {
    return sanitize(path.basename(workspaceFile.fsPath, path.extname(workspaceFile.fsPath)));
  }
  return 'untitled';
}

/** Sanitize a solution's display label into a URL id. */
export function solutionIdFromPath(solutionPath: string): string {
  return withReservedGuard(sanitizeApiId(path.basename(solutionPath, path.extname(solutionPath))));
}

/**
 * Pick an id not already taken: `base`, then `base-2`, `base-3`, … Reserved
 * routing words are treated as taken so a session can never be named "api".
 */
export function assignUniqueId(base: string, taken: ReadonlySet<string>, reserved: ReadonlySet<string> = RESERVED_IDS): string {
  if (!taken.has(base) && !reserved.has(base)) {
    return base;
  }
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`) || reserved.has(`${base}-${suffix}`)) {
    suffix++;
  }
  return `${base}-${suffix}`;
}

function withReservedGuard(id: string): string {
  return RESERVED_IDS.has(id) ? `${id}-1` : id;
}
