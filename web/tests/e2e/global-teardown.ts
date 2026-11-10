import { rmSync } from 'node:fs'
import { userPath } from './playwright.config'

export default async function globalTeardown() {
  try { rmSync(userPath, { recursive: true, force: true }) } catch { /* best effort */ }
}
