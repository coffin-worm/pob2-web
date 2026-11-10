import { mkdirSync } from 'node:fs'
import { userPath } from './playwright.config'

// The dev server reuses an engine that is already answering on :51990. If
// that is someone's real session, these tests would run against (and save
// into) their real builds, so refuse rather than carry on.
export default async function globalSetup() {
  mkdirSync(userPath, { recursive: true })
  const res = await fetch('http://127.0.0.1:51990/paths', { signal: AbortSignal.timeout(60_000) }).catch(() => null)
  if (!res || !res.ok) return // the dev server has not touched it yet; its own engine will use userPath
  const paths: { userPath?: string } = await res.json()
  const norm = (p: string) => p.split(String.fromCharCode(92)).join('/').toLowerCase()
  if (!paths.userPath || !norm(paths.userPath).startsWith(norm(userPath))) {
    throw new Error(
      'An engine that is not ours is already on :51990 (user path ' + paths.userPath + '). ' +
        'Stop it before running the e2e suite, or the tests would use your real builds folder.',
    )
  }
}
