import type { BridgeSnapshot } from './types';

/**
 * The transport to the Lua engine.
 *
 * The engine runs as a separate process serving JSON over loopback HTTP
 * (bridge/ in the repo root). Every call answers with a whole snapshot
 * rather than a diff, because one command can move several things at once --
 * changing class reloads the ascendancy list, and a recalculation can move
 * the level and all four budgets. A UI that patched fields individually
 * would be guessing at which ones moved.
 *
 * No WebSocket yet. The handshake is available (SHA-1 and base64 both ship
 * in runtime/lua) but request/response is enough for state this small, and
 * it keeps the failure modes obvious.
 */
const BASE =
  (import.meta.env.VITE_POB_BRIDGE as string | undefined) ?? 'http://127.0.0.1:49090';

async function request(path: string, init?: RequestInit): Promise<BridgeSnapshot> {
  const response = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

  // The bridge answers JSON on both success and failure, but a dead socket
  // or an HTML error page should not surface as a parse error.
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const detail =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `${response.status} ${response.statusText}`;
    throw new Error(detail);
  }

  return body as BridgeSnapshot;
}

export const bridge = {
  /** The current build, or `{ ready: false }` when none is open. */
  state: () => request('/state'),

  /** Ask the engine to run one of api.lua's commands. */
  act: (action: string, value?: unknown) =>
    request('/action', { method: 'POST', body: JSON.stringify({ action, value }) }),

  newBuild: () => request('/build/new', { method: 'POST', body: '{}' }),

  openBuild: (path: string) =>
    request('/build/open', { method: 'POST', body: JSON.stringify({ path }) }),
};
