/**
 * Getting hold of a calc engine.
 *
 * The engine is `bridge/` hosted by LOVE, serving JSON on loopback. It may
 * already be running: the dev server starts one on 49090, and the launcher
 * starts one on a port it picked itself. Either is worth attaching to, since
 * an engine already open is an engine with the build somebody is looking at
 * in it. Failing that, this starts its own.
 *
 * Nothing here writes to stdout. That belongs to the MCP transport, and a
 * single stray line on it corrupts the session, so PoB's own very chatty
 * boot output is piped and forwarded to stderr.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOVE_CANDIDATES = [
  'C:/Program Files/LOVE/lovec.exe',
  'C:/Program Files (x86)/LOVE/lovec.exe',
  '/usr/bin/love',
  '/usr/local/bin/love',
];

/** The ports bridge/main.lua tries when nobody tells it otherwise. */
const DEFAULT_PORTS = [49090, 49091, 49092];

const STARTUP_TIMEOUT_MS = 90_000;
const HEALTH_TIMEOUT_MS = 700;

export class EngineFailure extends Error {}

export interface Engine {
  /** `http://127.0.0.1:<port>`, with no trailing slash. */
  readonly base: string;
  readonly port: number;
  /**
   * This process started it, so nothing else is looking at the build in it.
   * False for an engine we attached to, which may have a window on it.
   */
  readonly ours: boolean;
  stop(): void;
}

function log(message: string) {
  process.stderr.write(`[pob2-mcp] ${message}\n`);
}

/* --------------------------------------------------------------- the paths */

/** The checkout: the directory holding bridge/, src/ and runtime/. */
export function findRoot(): string {
  const configured = process.env.POB_ROOT;
  if (configured) {
    if (!looksLikeRoot(configured)) {
      throw new EngineFailure(
        `POB_ROOT is ${configured}, which has no bridge/main.lua beside a src/.`,
      );
    }
    return path.resolve(configured);
  }

  // dist/engine.js, so the checkout is two levels up in a built package and
  // two again from src/ when this is run through a type-stripping node.
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (looksLikeRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new EngineFailure(
    'could not find the Path of Building checkout. Set POB_ROOT to the ' +
      'directory holding bridge/, src/ and runtime/.',
  );
}

function looksLikeRoot(dir: string): boolean {
  return (
    existsSync(path.join(dir, 'bridge', 'main.lua')) && existsSync(path.join(dir, 'src'))
  );
}

/** LOVE is a LuaJIT host that happens to be installed; see bridge/conf.lua. */
function findLove(root: string): string | null {
  const configured = process.env.POB_LOVE;
  if (configured) return existsSync(configured) ? configured : null;

  // The published folder carries its own copy, which is the one to prefer:
  // it is the one the rest of that folder was tested against.
  const bundled = path.join(root, 'love', process.platform === 'win32' ? 'lovec.exe' : 'love');
  if (existsSync(bundled)) return bundled;

  return LOVE_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

function announcementFile(): string {
  return path.join(os.tmpdir(), 'pob2-bridge.json');
}

/** Where bridge/main.lua says it is listening. */
function announcedPort(): number | null {
  const file = announcementFile();
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && 'port' in parsed) {
      const port = Number((parsed as { port: unknown }).port);
      return Number.isInteger(port) && port > 0 ? port : null;
    }
  } catch {
    // No file, or a half-written one. Either way there is nothing to attach
    // to here and the fixed ports are tried next.
  }
  return null;
}

/* ----------------------------------------------------------- the handshake */

async function answering(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * A port nothing is using.
 *
 * Asked of the OS and then handed to a different process, so in principle
 * something could take it in between. Nothing does in practice, and the
 * alternative is a fixed port that collides with the dev server's engine,
 * which happens constantly.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new EngineFailure('the OS did not say which port it gave us'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/* ------------------------------------------------------------- the process */

/**
 * Stop the engine.
 *
 * spawnSync rather than spawn, because this runs from process exit
 * handlers. Starting an asynchronous child while the event loop is tearing
 * itself down aborts node outright, with a libuv assertion from async.c
 * rather than anything that reads like a cause.
 *
 * taskkill rather than child.kill(), because child.kill() leaves LOVE
 * running often enough to matter, and a surviving engine is then attached
 * to by the next run.
 */
function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' });
  } else {
    child.kill();
  }
}

async function start(root: string): Promise<Engine> {
  const love = findLove(root);
  if (!love) {
    throw new EngineFailure(
      'LOVE was not found, so the engine cannot be started. Install it, or ' +
        'set POB_LOVE to lovec.exe.',
    );
  }

  const port = await freePort();
  const srcDir = path.join(root, 'src');
  const bridgeDir = path.join(root, 'bridge');

  log(`starting the engine on ${port}`);

  // HeadlessWrapper.lua resolves its own dofiles against the working
  // directory, so this has to be src/ and not the bridge directory.
  const child = spawn(love, [bridgeDir], {
    cwd: srcDir,
    env: {
      ...process.env,
      POB_SRC: srcDir,
      POB_RUNTIME: path.join(root, 'runtime'),
      POB_BRIDGE_DIR: bridgeDir,
      POB_BRIDGE_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  /** The engine's last words, for a failure worth more than "it did not start". */
  const said: string[] = [];
  const remember = (data: Buffer) => {
    for (const line of String(data).split(/\r?\n/)) {
      if (!line.trim()) continue;
      said.push(line);
      if (said.length > 40) said.shift();
      if (line.startsWith('[bridge]')) log(line);
    }
  };
  child.stdout?.on('data', remember);
  child.stderr?.on('data', remember);

  let exited: string | null = null;
  child.once('exit', (code) => {
    exited = `the engine exited with code ${code ?? 'unknown'}`;
  });
  child.once('error', (error) => {
    exited = `could not start the engine: ${error.message}`;
  });

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      throw new EngineFailure(`${exited}\n${said.slice(-12).join('\n')}`);
    }
    if (await answering(port)) {
      log('the engine is answering');
      return handle(port, true, child);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  kill(child);
  throw new EngineFailure(
    `the engine did not answer within ${STARTUP_TIMEOUT_MS / 1000}s.\n` +
      said.slice(-12).join('\n'),
  );
}

function handle(port: number, ours: boolean, child: ChildProcess | null): Engine {
  let stopped = false;
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    ours,
    stop() {
      if (stopped || !child) return;
      stopped = true;
      kill(child);
      // The engine takes its own announcement back when it is asked to
      // quit, and a forced kill never gives it the chance. So whoever did
      // the killing cleans up, and only if the file is still ours: an
      // engine started since then has already overwritten it.
      try {
        if (announcedPort() === port) rmSync(announcementFile());
      } catch {
        // A stale announcement is harmless. Every reader health-checks the
        // port it finds, and a dead one just means looking elsewhere.
      }
    },
  };
}

/* ---------------------------------------------------------------- the door */

export interface ConnectOptions {
  /** Start an engine of our own even if one is already answering. */
  own?: boolean;
}

/**
 * An engine to talk to, attached to or started.
 *
 * Attaching is the default and is usually what somebody means: an engine
 * that is already up has a build loaded, and often a window showing it. A
 * server that always started its own would answer questions about an empty
 * character while the real one sat on the next port along.
 */
export async function connect(options: ConnectOptions = {}): Promise<Engine> {
  const root = findRoot();

  const explicit = process.env.POB_BRIDGE_PORT;
  if (explicit) {
    const port = Number(explicit);
    if (!Number.isInteger(port) || port <= 0) {
      throw new EngineFailure(`POB_BRIDGE_PORT is ${explicit}, which is not a port.`);
    }
    // Named explicitly, so a dead one is an error rather than a reason to
    // go looking elsewhere: somebody is waiting on that particular engine.
    if (!(await answering(port))) {
      throw new EngineFailure(`nothing is answering on the port you named, ${port}.`);
    }
    log(`attached to the engine on ${port}, named by POB_BRIDGE_PORT`);
    return handle(port, false, null);
  }

  if (!options.own) {
    const announced = announcedPort();
    const candidates = announced === null ? DEFAULT_PORTS : [announced, ...DEFAULT_PORTS];
    for (const port of new Set(candidates)) {
      if (await answering(port)) {
        log(`attached to the engine already on ${port}`);
        return handle(port, false, null);
      }
    }
  }

  return start(root);
}
