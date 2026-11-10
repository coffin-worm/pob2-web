import { engineGet, expect, openApp, openView, test } from './fixtures'

test.describe('the Import view', () => {
  test.beforeEach(async ({ page }) => {
    // The account transport lives in the dev server and talks to
    // pathofexile.com, which tests must not do. Answer it as a signed-in
    // account with one character so the import controls are on screen. The
    // engine behind them is the real one; only GGG is stood in for.
    await page.route('**/poe/status', (route) =>
      route.fulfill({
        json: { authenticated: true, signInPending: false, expiresAt: null, error: null },
      }),
    )
    await page.route('**/poe/characters', (route) =>
      route.fulfill({
        json: {
          characters: [
            { name: 'TestRanger', class: 'Ranger', level: 12, league: 'Standard', current: true, expired: false, deleted: false },
          ],
        },
      }),
    )
  })

  test('shows the two import buttons, the four checkboxes and the mode dropdown', async ({ page, watch }) => {
    await openApp(page)
    await openView(page, 'Import')

    await expect(page.getByRole('button', { name: 'Passive Tree and Jewels' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Items and Skills' })).toBeVisible()

    for (const label of ['Delete jewels', 'Delete skills', 'Delete equipment', 'Ignore weapon swap']) {
      await expect(page.getByRole('checkbox', { name: label })).toBeVisible()
    }
    // PoB's own defaults.
    await expect(page.getByRole('checkbox', { name: 'Delete jewels' })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: 'Delete skills' })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: 'Delete equipment' })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: 'Ignore weapon swap' })).not.toBeChecked()

    const mode = page.getByRole('combobox', { name: 'Where to import' })
    await expect(mode).toBeVisible()
    await expect(mode).toContainText('Import to a new build')
    await mode.click()
    await expect(page.getByRole('option', { name: 'Import to this build' })).toBeVisible()
    await expect(page.getByRole('option', { name: 'Import as comparison' })).toBeVisible()
    await page.keyboard.press('Escape')
    expect(watch.errors).toEqual([])
  })

  test('a pasted build code is reported valid', async ({ page }) => {
    await openApp(page)
    // A real code, from the real engine's own export.
    const { code } = await engineGet(page, '/code')
    expect(code.length).toBeGreaterThan(20)

    await openView(page, 'Import')
    await page.getByLabel('Build code').fill(code)
    await expect(page.getByText(/level \d+/)).toBeVisible()
    await expect(page.getByText(/chars\s*→/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeEnabled()
  })

  test('pasted rubbish is refused', async ({ page }) => {
    await openApp(page)
    await openView(page, 'Import')
    await page.getByLabel('Build code').fill('this is definitely not a build code')
    // The engine's reason is shown and Import stays disabled.
    await expect(page.locator('[class*="bad"]')).toBeVisible()
    await expect(page.locator('[class*="bad"]')).not.toBeEmpty()
    await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeDisabled()
  })

  test('a link to an unknown host is refused locally', async ({ page, watch }) => {
    const external: string[] = []
    page.on('request', (r) => {
      const url = new URL(r.url())
      if (url.hostname === 'example.com') external.push(r.url())
    })
    await openApp(page)
    await openView(page, 'Import')
    await page.getByLabel('Build code').fill('https://example.com/x')
    await expect(page.getByText('that is not a build site this knows')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeDisabled()
    expect(external, 'nothing was fetched from the unknown host').toEqual([])
    expect(watch.forbidden).toEqual([])
  })
})
