import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin, PreviewServer, ViteDevServer } from 'vite';

/**
 * Sign in to pathofexile.com and list your characters.
 *
 * PoB does this itself, in `PoEAPI.lua`: OAuth 2.0 with PKCE, a throwaway
 * HTTP server to catch the redirect, then `/character/poe2` for the list and
 * `/character/poe2/<name>` for one character. None of it runs in the
 * headless host. `LaunchSubScript` and `OpenURL` are empty stubs in
 * `src/_SimpleGraphic.def.lua`, and `launch:DownloadPage` is a Lua source
 * string that it hands to `LaunchSubScript`, so the import tab's whole
 * network layer is inert there, and `FetchAuthToken` never gets past its
 * `if id then`.
 *
 * Rather than rebuild curl and a subscript host over FFI, the transport
 * moves to the side that already has TLS and a socket library. What it
 * emphatically does *not* move is the import itself: the character JSON goes
 * to the bridge's `POST /code/character`, which calls PoB's own
 * `ImportItemsAndSkills` and `ImportPassiveTreeAndJewels`. This file fetches
 * bytes and holds a token; the engine decides what they mean.
 *
 * Three details here are copied rather than invented, because getting them
 * wrong fails in ways that look like something else:
 *
 *  - `client_id=pob`. PoB's registered public client. A fork cannot mint its
 *    own without GGG registering it, so this identifies itself as what it
 *    is: a build of PoB.
 *  - The redirect ports are **49082, 49083, 49084**, and the redirect URI is
 *    `http://localhost:<port>` with no path (`src/LaunchServer.lua:11`).
 *    Those exact origins are what GGG has registered. An ephemeral port, or
 *    a tidier `/callback` path, earns `redirect_uri_mismatch`.
 *  - The User-Agent is `Path of Building/<version>` from `manifest.xml`,
 *    as `Launch.lua:273` sends it.
 *
 * Tokens live in this process's memory and nowhere else. They are not
 * written to disk, not given to the browser, and not logged; a dev-server
 * restart means signing in again. That is the right trade for a refresh
 * token that can read someone's account, and it is why the browser only ever
 * sees "authenticated: true".
 */

const CLIENT_ID = 'pob';
const SCOPES = ['account:profile', 'account:leagues', 'account:characters', 'account:trade'];
const AUTH_HOST = 'https://www.pathofexile.com';
const API_HOST = 'https://api.pathofexile.com';
/** Always poe2 here; PoEAPI.lua takes it as an argument and says the same. */
const REALM = 'poe2';
/** Registered with the OAuth client. Not ours to choose. */
const REDIRECT_PORTS = [49082, 49083, 49084];
/**
 * How long the redirect server waits.
 *
 * PoB allows 60 seconds, which assumes an already-signed-in browser and one
 * click. In practice there can be a login, a password manager and a
 * Cloudflare challenge in the way, and a window that closes mid-challenge
 * fails as "timed out" long after the user has stopped being able to tell
 * what went wrong. An idle listener on a loopback port costs nothing.
 */
const SIGN_IN_WINDOW_MS = 600_000;

interface Options {
  /** The PoB checkout, for reading manifest.xml. */
  repoRoot: string;
  /** The dev-server path these routes are served under. */
  mount?: string;
}

interface Token {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms. */
  expiresAt: number;
}

interface Pending {
  verifier: string;
  state: string;
  redirectUri: string;
  server: Server;
  timer: NodeJS.Timeout;
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `Path of Building/0.23.1`, the same string the desktop app sends. */
function userAgent(repoRoot: string): string {
  let version = '0.0.0';
  try {
    const manifest = readFileSync(path.join(repoRoot, 'manifest.xml'), 'utf-8');
    version = manifest.match(/<Version number="([^"]+)"/)?.[1] ?? version;
  } catch {
    // A missing manifest is not worth refusing to talk to the API over.
  }
  return `Path of Building/${version}`;
}

export function poeAccount(options: Options): Plugin {
  const mount = options.mount ?? '/poe';
  const ua = userAgent(options.repoRoot);

  let token: Token | null = null;
  let pending: Pending | null = null;
  /**
   * The last thing that went wrong.
   *
   * Deliberately *not* cleared when it is read. It was, and that made the
   * failure it exists to report unreadable: the UI polls this twice a
   * second while a sign-in is open, so whichever poll arrived first ate the
   * message and the panel showed it for one frame. It is cleared when the
   * next sign-in starts, which is the only moment it stops being true.
   */
  let lastError: string | null = null;

  const clearPending = () => {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.server.closeAllConnections?.();
    pending.server.close();
    pending = null;
  };

  /** POST to the token endpoint. Shared by the code and refresh grants. */
  const postToken = async (body: Record<string, string>): Promise<Token> => {
    const response = await fetch(`${AUTH_HOST}/oauth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': ua,
      },
      body: new URLSearchParams(body).toString(),
    });

    const text = await response.text();
    if (!response.ok) {
      // GGG's error bodies are small and specific ("invalid_grant"), and far
      // more use than the status alone.
      throw new Error(`token endpoint returned ${response.status}: ${text.slice(0, 200)}`);
    }

    const parsed = JSON.parse(text) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!parsed.access_token) {
      throw new Error('the token endpoint returned no access token');
    }
    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token ?? null,
      expiresAt: Date.now() + (parsed.expires_in ?? 600) * 1000,
    };
  };

  /**
   * Bind the redirect server to one of the registered ports.
   *
   * Tried in order, as LaunchServer.lua does. All three being busy is worth
   * a clear message: it usually means the desktop app is mid-sign-in.
   */
  const bindRedirect = (handler: (req: IncomingMessage, res: ServerResponse) => void) =>
    new Promise<{ server: Server; port: number }>((resolve, reject) => {
      const tryPort = (index: number) => {
        if (index >= REDIRECT_PORTS.length) {
          reject(
            new Error(
              `ports ${REDIRECT_PORTS.join(', ')} are all in use. These are the ` +
                'redirect ports registered with the OAuth client, so sign-in cannot ' +
                'use another one. Close the desktop PoB if it is signing in.',
            ),
          );
          return;
        }
        const port = REDIRECT_PORTS[index];
        const server = createServer(handler);
        server.once('error', () => {
          server.close();
          tryPort(index + 1);
        });
        // Explicitly IPv4: the redirect URI says localhost, and a listener on
        // ::1 alone does not catch a browser that resolves it to 127.0.0.1.
        server.listen(port, '127.0.0.1', () => resolve({ server, port }));
      };
      tryPort(0);
    });

  /** The page the browser lands on after GGG redirects back. */
  const landingPage = (ok: boolean, detail?: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${ok ? 'Signed in' : 'Sign-in failed'}</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#121212; color:#e8e8e8;
         font:16px/1.6 ui-sans-serif, system-ui, sans-serif }
  .card { max-width:30rem; padding:2rem; background:#1e1e1e;
          border:1px solid #2e2e2e; border-radius:.75rem; text-align:center }
  h1 { margin:0 0 .5rem; font-size:1.25rem; color:${ok ? '#7bc96f' : '#e06c75'} }
  p { margin:0; color:#a8a8a8 }
  code { color:#e06c75; word-break:break-all }
</style></head>
<body><div class="card">
  <h1>${ok ? 'Signed in' : 'Sign-in failed'}</h1>
  <p>${
    ok
      ? 'You can close this tab and go back to Path of Building.'
      : `<code>${detail ?? 'unknown error'}</code>`
  }</p>
</div></body></html>`;

  /**
   * Start a sign-in and return the URL the browser should go to.
   *
   * The caller navigates there; nothing here opens a browser or submits
   * anything. The credentials are typed on GGG's own page, which is the only
   * place they should be.
   */
  const beginSignIn = async (): Promise<string> => {
    clearPending();
    lastError = null;

    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = randomBytes(8).toString('hex');

    const handler = (req: IncomingMessage, res: ServerResponse) => {
      const current = pending;
      if (!current) {
        res.statusCode = 410;
        res.end('sign-in is no longer pending');
        return;
      }

      // Anything but the redirect is ignored and the server keeps listening.
      // LaunchServer.lua has the same retry, for the same reason: VPNs and OS
      // services probe freshly opened ports, and giving up on the first
      // stray connection loses the real one.
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.end();
        return;
      }

      const query = new URL(req.url ?? '/', `http://localhost`).searchParams;
      const code = query.get('code');
      const error = query.get('error');
      if (!code && !error) {
        res.statusCode = 204;
        res.end();
        return;
      }

      const finish = (ok: boolean, detail?: string) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(landingPage(ok, detail));
        clearPending();
      };

      if (error) {
        lastError = `${error}: ${query.get('error_description') ?? 'no description'}`;
        finish(false, lastError);
        return;
      }

      // The state check is the whole defence against a forged redirect, so a
      // mismatch throws the code away rather than spending it.
      if (query.get('state') !== current.state) {
        lastError = 'OAuth state mismatch; the sign-in was not completed';
        finish(false, lastError);
        return;
      }

      postToken({
        client_id: CLIENT_ID,
        grant_type: 'authorization_code',
        code: code as string,
        redirect_uri: current.redirectUri,
        scope: SCOPES.join(' '),
        code_verifier: current.verifier,
      })
        .then((fresh) => {
          token = fresh;
          finish(true);
        })
        .catch((err: unknown) => {
          lastError = err instanceof Error ? err.message : String(err);
          finish(false, lastError);
        });
    };

    const { server, port } = await bindRedirect(handler);
    const redirectUri = `http://localhost:${port}`;

    const timer = setTimeout(() => {
      lastError = 'sign-in timed out before the browser came back';
      clearPending();
    }, SIGN_IN_WINDOW_MS);
    // Never hold the dev server open waiting for a sign-in nobody finished.
    timer.unref?.();

    pending = { verifier, state, redirectUri, server, timer };

    // Built by hand rather than with URLSearchParams so the scopes are
    // %20-separated, matching PoEAPI.lua:97 exactly.
    return (
      `${AUTH_HOST}/oauth/authorize?client_id=${CLIENT_ID}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(SCOPES.join(' '))}` +
      `&state=${state}` +
      `&code_challenge=${challenge}` +
      `&code_challenge_method=S256` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}`
    );
  };

  /** A valid access token, refreshed if it is close to expiry. */
  const validToken = async (): Promise<string | null> => {
    if (!token) return null;
    // Thirty seconds of slack: a token that expires mid-flight reads as a
    // mysterious 401 rather than as the clock.
    if (token.expiresAt > Date.now() + 30_000) return token.accessToken;
    if (!token.refreshToken) {
      token = null;
      return null;
    }
    try {
      token = await postToken({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken,
      });
      return token.accessToken;
    } catch (err) {
      lastError = `could not refresh the token: ${
        err instanceof Error ? err.message : String(err)
      }`;
      token = null;
      return null;
    }
  };

  interface ApiResult {
    status: number;
    body: string;
    retryAfter?: number;
  }

  /**
   * GET an API endpoint with the bearer token, refreshing once on a 401.
   *
   * 429 is passed back with GGG's own retry hint instead of being retried
   * here: their limits are per-account and measured in minutes, so the only
   * useful thing to do with one is tell the person how long to wait.
   */
  const apiGet = async (endpoint: string, retried = false): Promise<ApiResult> => {
    const access = await validToken();
    if (!access) {
      return { status: 401, body: JSON.stringify({ error: 'not signed in' }) };
    }

    const response = await fetch(`${API_HOST}${endpoint}`, {
      headers: { authorization: `Bearer ${access}`, 'user-agent': ua },
    });

    if (response.status === 401 && !retried && token?.refreshToken) {
      // Force the refresh path and try once more, as DownloadWithRefresh does.
      token = { ...token, expiresAt: 0 };
      return apiGet(endpoint, true);
    }

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after') ?? '60');
      return {
        status: 429,
        body: JSON.stringify({ error: 'rate limited by the API' }),
        retryAfter: Number.isFinite(retryAfter) ? retryAfter : 60,
      };
    }

    return { status: response.status, body: await response.text() };
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
        switch (route) {
          case 'GET /status': {
            reply(200, {
              authenticated: Boolean(token),
              signInPending: Boolean(pending),
              expiresAt: token?.expiresAt ?? null,
              error: lastError,
            });
            return;
          }

          // A redirect rather than JSON, so the button can be an ordinary
          // link. The navigation is then the user's own click, with no
          // popup-blocker gap and no question about who initiated it.
          //
          // ?format=json hands back the URL instead, for copying into
          // another browser. LaunchServer.lua puts it on the clipboard for
          // the same reason, and the reason is a good one: the sign-in can
          // be impossible in the browser that happens to be in front of
          // you: an embedded or automated one will loop a Cloudflare
          // challenge forever, while working first try in a normal one.
          case 'GET /signin': {
            const authUrl = await beginSignIn();
            if (url.searchParams.get('format') === 'json') {
              reply(200, { authUrl });
              return;
            }
            res.statusCode = 302;
            res.setHeader('location', authUrl);
            res.setHeader('cache-control', 'no-store');
            res.end();
            return;
          }

          case 'POST /signout': {
            token = null;
            clearPending();
            lastError = null;
            reply(200, { authenticated: false });
            return;
          }

          case 'GET /characters': {
            const result = await apiGet(`/character/${REALM}`);
            if (result.status !== 200) {
              reply(result.status, {
                error: JSON.parse(result.body)?.error ?? 'could not list characters',
                retryAfter: result.retryAfter,
              });
              return;
            }
            const parsed = JSON.parse(result.body) as {
              characters?: Array<Record<string, unknown>>;
            };
            // Trimmed to what the list actually shows. The full object is
            // large and the browser has no use for the rest.
            reply(200, {
              characters: (parsed.characters ?? []).map((char) => ({
                name: String(char.name ?? ''),
                class: String(char.class ?? ''),
                level: Number(char.level ?? 0),
                league: typeof char.league === 'string' ? char.league : null,
                current: Boolean(char.current),
                expired: Boolean(char.expired),
                deleted: Boolean(char.deleted),
              })),
            });
            return;
          }

          case 'GET /character': {
            const name = url.searchParams.get('name');
            if (!name) {
              reply(400, { error: 'expected ?name=' });
              return;
            }
            const result = await apiGet(`/character/${REALM}/${encodeURIComponent(name)}`);
            if (result.status !== 200) {
              reply(result.status, {
                error: JSON.parse(result.body)?.error ?? 'could not fetch that character',
                retryAfter: result.retryAfter,
              });
              return;
            }
            // Passed through exactly as GGG sent it. The envelope it comes
            // in is the engine's business, not this file's: the bridge
            // unwraps it, so there is one place that knows the shape.
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.setHeader('cache-control', 'no-store');
            res.end(result.body);
            return;
          }

          default:
            reply(404, { error: `no route ${route}` });
        }
      } catch (err) {
        reply(500, { error: err instanceof Error ? err.message : String(err) });
      }
    };

    server.middlewares.use(mount, handler);

    const shutdown = () => clearPending();
    server.httpServer?.once('close', shutdown);
    process.once('exit', shutdown);
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  };

  return {
    name: 'poe-account',
    // Same reasoning as pob-bridge: `serve` is dev and preview, and a build
    // has no server to hang this on.
    apply: 'serve',
    configureServer: attach,
    configurePreviewServer: attach,
  };
}
