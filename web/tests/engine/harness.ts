// Boots a real engine (lovec.exe running bridge/main.lua) and talks to its
// HTTP routes. Nothing is mocked: the point is to catch integration
// regressions between the bridge and PoB.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

export function findLove(): string {
  const candidates = [
    process.env.POB_LOVE,
    'C:/Program Files/LOVE/lovec.exe',
    path.join(repoRoot, 'love', 'lovec.exe'),
  ].filter((p): p is string => !!p)
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error('lovec.exe not found; install LOVE or set POB_LOVE. Tried: ' + candidates.join(', '))
  return found
}

function freePort(start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (port: number) => {
      const srv = createServer()
      srv.once('error', () => (port < start + 200 ? attempt(port + 1) : reject(new Error('no free port'))))
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(port)))
    }
    attempt(start)
  })
}

export function killTree(pid: number | undefined) {
  if (!pid) return
  spawnSync('taskkill', ['/pid', String(pid), '/f', '/t'], { stdio: 'ignore' })
}

export interface Engine {
  base: string
  port: number
  userPath: string
  child: ChildProcess
  log: string[]
  get<T = any>(route: string): Promise<{ status: number; body: T }>
  post<T = any>(route: string, body?: unknown): Promise<{ status: number; body: T }>
  action<T = any>(action: string, value?: unknown): Promise<{ status: number; body: T }>
  stop(): void
}

export async function startEngine(): Promise<Engine> {
  const love = findLove()
  const port = await freePort(51930)
  // The builds folder lives under POB_USER_PATH, so a throwaway one keeps
  // every file these tests write away from the real Documents folder.
  const userPath = mkdtempSync(path.join(tmpdir(), 'pob-engine-test-'))
  const log: string[] = []

  const child = spawn(love, [path.join(repoRoot, 'bridge')], {
    cwd: path.join(repoRoot, 'src'),
    env: {
      ...process.env,
      POB_SRC: path.join(repoRoot, 'src'),
      POB_RUNTIME: path.join(repoRoot, 'runtime'),
      POB_BRIDGE_DIR: path.join(repoRoot, 'bridge'),
      POB_BRIDGE_PORT: String(port),
      POB_USER_PATH: userPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const onData = (d: Buffer) => log.push(d.toString())
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  // Last resort: if the test process itself dies, do not leave LOVE behind.
  const onExit = () => killTree(child.pid)
  process.on('exit', onExit)

  const base = `http://127.0.0.1:${port}`
  const request = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(base + route, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
  }

  const engine: Engine = {
    base, port, userPath, child, log,
    get: (route) => request('GET', route),
    post: (route, body) => request('POST', route, body ?? {}),
    action: (action, value) => request('POST', '/action', { action, value }),
    stop() {
      killTree(child.pid)
      process.off('exit', onExit)
      try { rmSync(userPath, { recursive: true, force: true }) } catch { /* best effort */ }
    },
  }

  try {
    const deadline = Date.now() + 150_000
    for (;;) {
      if (child.exitCode !== null) throw new Error(`engine exited with ${child.exitCode}:\n${log.join('')}`)
      if (Date.now() > deadline) throw new Error('engine did not answer /health in time:\n' + log.join(''))
      try {
        const res = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) })
        if (res.ok) {
          const h: any = await res.json()
          if (h.booted) break
        }
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 500))
    }
  } catch (e) {
    engine.stop()
    throw e
  }
  return engine
}
