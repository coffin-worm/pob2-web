import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Connect, Plugin, PreviewServer, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Runs PoB's calc engine alongside the dev server.
 *
 * Before this, working on the UI meant starting two processes by hand in the
 * right order from the right directory, and the page said "engine not
 * reachable" whenever you forgot. Now `npm run dev` is the whole thing.
 *
 * The plugin also proxies the engine under the dev server's own origin, which
 * means the browser makes same-origin requests and the port the engine ended
 * up on stops being the UI's problem.
 */

const LOVE_CANDIDATES = [
  'C:/Program Files/LOVE/lovec.exe',
  'C:/Program Files (x86)/LOVE/lovec.exe',
  '/usr/bin/love',
  '/usr/local/bin/love',
];

interface Options {
  /** The PoB checkout: the directory holding src/, runtime/ and bridge/. */
  repoRoot: string;
  /** Where the engine listens. Also where this proxies to. */
  port?: number;
  /** The dev-server path the engine is served under. */
  mount?: string;
  /** How long to wait for the engine's ready line before giving up. */
  startupTimeoutMs?: number;
}

/** LOVE is a LuaJIT host that happens to be installed; see bridge/conf.lua. */
function findLove(): string | null {
  const configured = process.env.POB_LOVE;
  if (configured) {
    return existsSync(configured) ? configured : null;
  }
  return LOVE_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

async function isAlreadyRunning(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    // child.kill() leaves LOVE running often enough to matter: a surviving
    // engine is then reused by the next start, and you spend a while
    // wondering why a change to api.lua did nothing.
    spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' });
  } else {
    child.kill();
  }
}

export function pobBridge(options: Options): Plugin {
  const port = options.port ?? 49090;
  const mount = options.mount ?? '/bridge';
  const timeoutMs = options.startupTimeoutMs ?? 60_000;

  const srcDir = path.join(options.repoRoot, 'src');
  const runtimeDir = path.join(options.repoRoot, 'runtime');
  const bridgeDir = path.join(options.repoRoot, 'bridge');

  let child: ChildProcess | null = null;
  let ready: Promise<void> | null = null;
  let failure: string | null = null;
  /**
   * Set when no amount of restarting will help, which is only ever LOVE
   * being absent. Every other failure is worth another go, and separating
   * the two is what stops a broken install from paying for a health check
   * on every request.
   */
  let fatal = false;
  /**
   * The start in flight, if there is one.
   *
   * Several requests can discover a dead engine in the same tick, and they
   * should queue behind one attempt rather than each spawning their own.
   */
  let starting: Promise<void> | null = null;

  /**
   * Start the engine and proxy to it, for whichever server is asking.
   *
   * Both the dev server and `vite preview` get this. The preview one
   * matters more than it looks: it is the only way to run what actually
   * ships, and without it a built app serves a UI with nothing behind it:
   * every request a 404, which reads as "the engine is broken" rather
   * than "nobody wired this up".
   */
  const attach = async (server: ViteDevServer | PreviewServer) => {
      const log = server.config.logger;

      const spawnEngine = async () => {
        const love = findLove();
        if (!love) {
          failure =
            'LOVE was not found. Install it, or set POB_LOVE to lovec.exe. ' +
            'The UI will load but the engine will be unreachable.';
          fatal = true;
          log.warn(`[pob-bridge] ${failure}`);
          return;
        }

        // Whatever went wrong last time is about to stop being true.
        failure = null;

        // HeadlessWrapper.lua resolves its own dofiles against the working
        // directory, so this has to be src/ and not the bridge directory.
        child = spawn(love, [bridgeDir], {
          cwd: srcDir,
          env: {
            ...process.env,
            POB_SRC: srcDir,
            POB_RUNTIME: runtimeDir,
            POB_BRIDGE_DIR: bridgeDir,
            POB_BRIDGE_PORT: String(port),
            // Tie the engine to this process. The shutdown below kills it on a
            // clean stop and cannot run on a forced one, so the engine is told
            // whose death to watch for instead.
            POB_BRIDGE_OWNER: String(process.pid),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            failure = `the engine did not report ready within ${timeoutMs / 1000}s`;
            log.warn(`[pob-bridge] ${failure}`);
            resolve();
          }, timeoutMs);

          const settle = () => {
            clearTimeout(timer);
            resolve();
          };

          // PoB is chatty on boot (tree data, uniques). Only its own lines and
          // anything that looks like a failure are worth the terminal.
          child?.stdout?.on('data', (data: Buffer) => {
            for (const line of String(data).split(/\r?\n/)) {
              if (!line.trim()) continue;
              if (line.startsWith('[bridge]')) log.info(`[pob-bridge] ${line.slice(9)}`);
              if (line.includes('listening on')) settle();
            }
          });

          child?.stderr?.on('data', (data: Buffer) => {
            log.error(`[pob-bridge] ${String(data).trimEnd()}`);
          });

          child?.on('exit', (code) => {
            if (code !== 0 && code !== null) {
              failure = `the engine exited with code ${code}`;
              log.error(`[pob-bridge] ${failure}`);
            }
            child = null;
            settle();
          });

          child?.on('error', (error) => {
            failure = `could not start the engine: ${error.message}`;
            log.error(`[pob-bridge] ${failure}`);
            settle();
          });
        });
      };

      /**
       * Have an engine, starting one if there is not one already.
       *
       * Reuse used to be decided once, at startup, and that was a race the
       * dev server lost regularly. Restarting Vite builds the new plugin
       * instance before tearing the old one down, so the new instance asks
       * ":49090, are you there?", gets a yes from the engine belonging to
       * the instance that is about to die, writes "reusing the engine
       * already on :49090", and then that engine is killed by the old
       * instance's shutdown. Nothing is left running and the log says
       * everything is fine.
       *
       * So reuse is no longer a decision anybody has to get right the
       * first time. This is cheap to call, idempotent, and the proxy calls
       * it again whenever a request cannot reach the engine.
       */
      const ensureEngine = (): Promise<void> => {
        if (!starting) {
          starting = (async () => {
            // Our own child, still alive.
            if (child && child.exitCode === null && child.signalCode === null) return;
            // Somebody else's, still alive: an engine started by hand, or
            // by a server instance on its way out that will outlive us.
            if (await isAlreadyRunning(port)) {
              log.info(`[pob-bridge] reusing the engine already on :${port}`);
              return;
            }
            await spawnEngine();
          })().finally(() => {
            starting = null;
          });
        }
        return starting;
      };

      ready = ensureEngine();

      // Requests arrive before the engine finishes booting: the browser is
      // usually faster, so they wait on it rather than failing.
      const proxy: Connect.NextHandleFunction = async (
        req: IncomingMessage,
        res: ServerResponse,
      ) => {
        await ready;

        const reply = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(body));
        };

        // A recorded failure goes stale: an engine that exited is usually
        // perfectly startable again, so the note about it is a reason to
        // try once more rather than a reason to refuse.
        if (failure && !fatal) await ensureEngine();
        if (failure) {
          reply(503, { error: failure });
          return;
        }

        let body: Buffer | undefined;
        if (req.method && !['GET', 'HEAD'].includes(req.method)) {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          body = Buffer.concat(chunks);
        }

        const forward = () =>
          fetch(`http://127.0.0.1:${port}${req.url ?? '/'}`, {
            method: req.method,
            headers: { 'content-type': 'application/json' },
            body,
          });

        let upstream: Response;
        try {
          upstream = await forward();
        } catch {
          // The engine was there when we last looked and is not now.
          // Start one and send the request again, once. The body was
          // buffered above, so the retry is a real retry and not a
          // half-consumed stream.
          log.warn(`[pob-bridge] nothing on :${port}; starting the engine again`);
          try {
            await ensureEngine();
            upstream = await forward();
          } catch (error) {
            reply(502, {
              error: `the engine stopped answering: ${
                error instanceof Error ? error.message : String(error)
              }`,
            });
            return;
          }
        }

        res.statusCode = upstream.status;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(Buffer.from(await upstream.arrayBuffer()));
      };

      server.middlewares.use(mount, proxy);

      const shutdown = () => {
        if (child) stop(child);
        child = null;
      };
      server.httpServer?.once('close', shutdown);
      process.once('exit', shutdown);
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
  };

  return {
    name: 'pob-bridge',
    // `serve` covers both `vite dev` and `vite preview`; the build itself
    // has no server to attach to.
    apply: 'serve',
    configureServer: attach,
    configurePreviewServer: attach,
  };
}
