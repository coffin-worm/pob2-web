/**
 * The build sites, as this app can reach them.
 *
 * Sharing and fetching both happen outside the engine, because PoB's own
 * upload and download go through `LaunchSubScript`, which is an empty stub
 * in the headless host. The transport is `web/plugins/build-sites.ts` under
 * the dev server and `launcher/BuildSites.cs` in the window; this file does
 * not care which, and talks to the same `/sites` mount either way.
 *
 * Nothing here decodes a build. What a site returns is a build code, which
 * is what the engine's own import already takes.
 */

export interface BuildSite {
  id: string;
  label: string;
  /** False for the sites that only serve builds, such as Pastebin. */
  uploads: boolean;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: 'no-store' });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${url} did not return JSON`);
  }
  if (!response.ok) {
    throw new Error((parsed as { error?: string } | null)?.error ?? response.statusText);
  }
  return parsed as T;
}

export const sites = {
  list: () => getJson<{ sites: BuildSite[] }>('/sites/list'),

  /** Which site a pasted link belongs to, or null for one we do not know. */
  recognise: (url: string) =>
    getJson<{ site: string | null; label?: string }>(
      `/sites/recognise?url=${encodeURIComponent(url)}`,
    ),

  /**
   * Fetch a build back from a link, as a code.
   *
   * The link goes to the transport rather than to `fetch` here, and that is
   * not indirection for its own sake: the transport matches it against the
   * sites it knows and requests a URL it derived itself, so a link cannot
   * aim this at somewhere else.
   */
  fetch: (url: string) =>
    getJson<{ code: string }>(`/sites/fetch?url=${encodeURIComponent(url)}`),

  /** Upload a code and get the link back. This publishes the build. */
  share: (site: string, code: string) =>
    getJson<{ url: string }>('/sites/share', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ site, code }),
    }),
};
