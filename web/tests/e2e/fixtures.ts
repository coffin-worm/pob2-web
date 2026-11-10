import { expect, test as base, type Page } from '@playwright/test'

// Hosts no test may reach. A real build link would hit one of these, so the
// tests never use one; this makes the promise enforceable rather than a habit.
const FORBIDDEN = /(^|\.)(pobb\.in|maxroll\.gg|poe\.ninja|poe2db\.tw|pastebin\.com|rentry\.co|rentry\.org)$/i

export const VIEWS = [
  ['Tree', 'tree'],
  ['Items', 'items'],
  ['Skills', 'skills'],
  ['Config', 'config'],
  ['Calcs', 'calcs'],
  ['Notes', 'notes'],
  ['Compare', 'compare'],
  ['Import', 'port'],
  ['Builds', 'builds'],
] as const

export interface Watch {
  errors: string[]
  forbidden: string[]
}

export const test = base.extend<{ watch: Watch }>({
  watch: async ({ page }, use) => {
    const watch: Watch = { errors: [], forbidden: [] }
    page.on('console', (m) => {
      if (m.type() === 'error') watch.errors.push(m.text())
    })
    page.on('pageerror', (e) => watch.errors.push('pageerror: ' + e.message))
    page.on('request', (r) => {
      try {
        if (FORBIDDEN.test(new URL(r.url()).hostname)) watch.forbidden.push(r.url())
      } catch { /* not a URL */ }
    })
    // Belt and braces: even if something tried, nothing leaves the machine.
    await page.route((url) => FORBIDDEN.test(url.hostname), (route) => route.abort())
    await use(watch)
    expect(watch.forbidden, 'no request to a build-sharing site').toEqual([])
  },
})

export { expect }

/** Open the app and wait until the engine has answered and the sidebar is populated. */
export async function openApp(page: Page) {
  await page.goto('/')
  await expect(page.getByText('Live: this is the real build')).toBeVisible({ timeout: 90_000 })
  await expect(page.getByText('Total Life', { exact: true })).toBeVisible({ timeout: 30_000 })
}

export async function openView(page: Page, label: string) {
  await page.getByRole('radio', { name: label, exact: true }).click()
  await expect(page.getByRole('radio', { name: label, exact: true })).toHaveAttribute('aria-checked', 'true')
}

/** The engine, through the dev server's /bridge mount. */
export async function engineGet(page: Page, route: string) {
  const res = await page.request.get('/bridge' + route)
  expect(res.ok(), route + ' answered').toBe(true)
  return res.json()
}
