import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'

// Fixed, because the dev server does not reliably get 5173 on this machine:
// other projects hold 5173-5177. Passed to vite as --port and used as the
// baseURL, so the two cannot drift.
const PORT = 5199
import { tmpdir } from 'node:os'
import path from 'node:path'
const webDir = fileURLToPath(new URL('../../', import.meta.url))

export const userPath = path.join(tmpdir(), 'pob-e2e-user')

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  outputDir: '../../test-results',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  // One engine behind the dev server and the tests share its build.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run dev -- --config tests/e2e/vite.e2e.config.ts --port ${PORT} --strictPort --host 127.0.0.1`,
    cwd: webDir,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
    // The engine's builds folder lives under POB_USER_PATH. A throwaway one
    // keeps saved builds out of the real Documents folder.
    env: { POB_USER_PATH: userPath },
  },
})
