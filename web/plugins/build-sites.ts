import type { Connect, Plugin, PreviewServer, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Sharing a build to pobb.in and the rest, and importing one back.
 *
 * PoB does this in `src/Modules/BuildSiteTools.lua`: a POST of the build
 * code to the site's own endpoint, and a GET of a raw URL to read one back.
 * Neither runs in the headless host. `UploadBuild` goes through
 * `LaunchSubScript`, which is an empty stub, and `DownloadBuild` goes
 * through `launch:DownloadPage`, which is the same stub one layer down. So
 * the Share button there does nothing at all, and an import from a URL sits
 * on "fetching" forever with no error.
 *
 * Same reasoning as `poe-account.ts`: the transport moves to the side that
 * has TLS and a socket library, and nothing else moves. What comes back
 * from a site is a build code, which is exactly what the engine's own
 * `/code/import` already takes, so this file never decodes or inflates
 * anything. It fetches bytes and hands them over.
 *
 * The site table below is PoB's, transcribed. It is the second of three
 * copies, after the Lua one and before `launcher/BuildSites.cs`, which is a
 * real cost and the same one the account transport pays. It is here rather
 * than read from the engine because this file must decide *where it is
 * allowed to send a request*, and a table it fetched from somewhere else
 * would not be a decision it had made.
 */

const SITES: Site[] = [
  {
    id: 'Maxroll',
    label: 'Maxroll',
    match: /^https:\/\/maxroll\.gg\/poe2\/pob\/(.+?)\s*$/,
    raw: (id) => `https://maxroll.gg/poe2/api/pob/${id}`,
    post: 'https://maxroll.gg/poe2/api/pob',
    field: 'pobCode=',
    codeOut: 'https://maxroll.gg/poe2/pob/',
  },
  {
    id: 'POBBin',
    label: 'pobb.in',
    match: /^https:\/\/pobb\.in\/(.+?)\s*$/,
    raw: (id) => `https://pobb.in/pob/${id}`,
    post: 'https://pobb.in/pob/',
    field: '',
    codeOut: 'https://pobb.in/',
  },
  {
    id: 'PoeNinja',
    label: 'poe.ninja',
    // PoB's own pattern allows poe.ninja/poe2/pob/ and poe2.ninja/pob/.
    match: /^https:\/\/poe2?\.ninja\/(?:poe2\/)?pob\/(.+?)\s*$/,
    raw: (id) => `https://poe.ninja/poe2/pob/raw/${id}`,
    post: 'https://poe.ninja/poe2/pob/api/upload',
    field: 'code=',
    // Empty in PoB too, which means the response body is already the URL.
    codeOut: '',
  },
  {
    id: 'PoE2DB',
    label: 'poe2db.tw',
    match: /^https:\/\/poe2db\.tw\/pob\/(.+?)\s*$/,
    raw: (id) => `https://poe2db.tw/pob/${id}/raw`,
    post: 'https://poe2db.tw/pob/api/gen',
    field: '',
    codeOut: '',
  },
  {
    id: 'pastebin',
    label: 'Pastebin.com',
    match: /^https:\/\/pastebin\.com\/(\w+)/,
    raw: (id) => `https://pastebin.com/raw/${id}`,
  },
  {
    id: 'pastebinProxy',
    label: 'PastebinP.com',
    match: /^https:\/\/pastebinp\.com\/(\w+)/,
    raw: (id) => `https://pastebinp.com/raw/${id}`,
  },
  {
    id: 'rentry',
    label: 'Rentry.co',
    // Unanchored in PoB as well, so a rentry link pasted with no scheme
    // still matches.
    match: /rentry\.co\/(\w+)/,
    raw: (id) => `https://rentry.co/paste/${id}/raw`,
  },
];

interface Site {
  id: string;
  label: string;
  /** Capture group 1 is the build's id on that site. */
  match: RegExp;
  raw: (id: string) => string;
  /** Absent on a site that only serves builds. */
  post?: string;
  /** Prepended to the code in the body, which is how PoB names its field. */
  field?: string;
  /** Prepended to the response to make the shareable link. */
  codeOut?: string;
}

interface Options {
  /** The PoB checkout, for reading manifest.xml. */
  repoRoot: string;
  mount?: string;
}

/** `Path of Building/0.23.1`, the same string the desktop app sends. */
function userAgent(repoRoot: string): string {
  let version = '0.0.0';
  try {
    const manifest = readFileSync(path.join(repoRoot, 'manifest.xml'), 'utf-8');
    version = manifest.match(/<Version number="([^"]+)"/)?.[1] ?? version;
  } catch {
    // A missing manifest is not worth refusing to talk to a site over.
  }
  return `Path of Building/${version}`;
}

/** The site a link belongs to, and the build's id on it. */
export function recognise(link: string): { site: Site; id: string } | null {
  const text = link.trim();
  for (const site of SITES) {
    const found = site.match.exec(text);
    if (found?.[1]) return { site, id: found[1] };
  }
  return null;
}

export function buildSites(options: Options): Plugin {
  const mount = options.mount ?? '/sites';
  const ua = userAgent(options.repoRoot);

  /**
   * Upload a code and return the link.
   *
   * The body is `field + code` with no content type set, which is what
   * curl's POSTFIELDS does and therefore what these endpoints expect. The
   * code is not URL-encoded, also as PoB sends it.
   */
  const share = async (site: Site, code: string): Promise<string> => {
    if (!site.post) throw new Error(`${site.label} does not take uploads`);

    const response = await fetch(site.post, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': ua,
      },
      body: `${site.field ?? ''}${code}`,
      redirect: 'follow',
    });

    const body = (await response.text()).trim();
    if (!response.ok) {
      throw new Error(
        `${site.label} answered ${response.status}: ${body.slice(0, 200) || 'nothing'}`,
      );
    }
    if (!body) throw new Error(`${site.label} accepted the build but returned no link`);

    // PoB uses the body verbatim, prefixed by codeOut. Where codeOut is
    // empty the body is expected to be the whole URL already.
    const link = `${site.codeOut ?? ''}${body}`;
    if (!/^https:\/\//.test(link)) {
      throw new Error(`${site.label} returned something that is not a link: ${link.slice(0, 200)}`);
    }
    return link;
  };

  /**
   * Fetch a build back, as a code.
   *
   * Only ever the URL this file derived from a recognised link, never the
   * one the page sent. That is the whole security boundary here: a page
   * that could name the URL could use this to reach anything the machine
   * can reach.
   */
  const fetchBuild = async (link: string): Promise<string> => {
    const known = recognise(link);
    if (!known) throw new Error('that link is not one of the build sites this knows');

    const response = await fetch(known.site.raw(known.id), {
      headers: { 'user-agent': ua },
      redirect: 'follow',
    });
    const body = (await response.text()).trim();
    if (!response.ok) {
      throw new Error(
        `${known.site.label} answered ${response.status}: ${body.slice(0, 200) || 'nothing'}`,
      );
    }
    if (!body) throw new Error(`${known.site.label} returned an empty build`);
    return body;
  };

  const attach = (server: ViteDevServer | PreviewServer) => {
    const handler: Connect.NextHandleFunction = async (
      req: IncomingMessage,
      res: ServerResponse,
    ) => {
      const reply = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify(body));
      };

      const url = new URL(req.url ?? '/', 'http://localhost');
      const route = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;

      try {
        if (route === 'GET /list') {
          reply(200, {
            sites: SITES.map((site) => ({
              id: site.id,
              label: site.label,
              uploads: Boolean(site.post),
            })),
          });
          return;
        }

        if (route === 'GET /recognise') {
          const known = recognise(url.searchParams.get('url') ?? '');
          reply(200, known ? { site: known.site.id, label: known.site.label } : { site: null });
          return;
        }

        if (route === 'GET /fetch') {
          const link = url.searchParams.get('url') ?? '';
          reply(200, { code: await fetchBuild(link) });
          return;
        }

        if (route === 'POST /share') {
          const body = await new Promise<string>((resolve, reject) => {
            let text = '';
            req.on('data', (chunk) => (text += String(chunk)));
            req.on('end', () => resolve(text));
            req.on('error', reject);
          });
          const asked = JSON.parse(body || '{}') as { site?: string; code?: string };
          const site = SITES.find((entry) => entry.id === asked.site);
          if (!site) {
            reply(400, { error: `no build site called ${asked.site ?? '(none)'}` });
            return;
          }
          if (!asked.code) {
            reply(400, { error: 'expected a build code to share' });
            return;
          }
          reply(200, { url: await share(site, asked.code) });
          return;
        }

        reply(404, { error: `no route ${route}` });
      } catch (err) {
        reply(502, { error: err instanceof Error ? err.message : String(err) });
      }
    };

    server.middlewares.use(mount, handler);
  };

  return {
    name: 'build-sites',
    // Same reasoning as the other two: `serve` is dev and preview, and a
    // build has no server to hang this on.
    apply: 'serve',
    configureServer: attach,
    configurePreviewServer: attach,
  };
}
