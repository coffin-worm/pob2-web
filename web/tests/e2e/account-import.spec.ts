import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, openApp, openView, test } from './fixtures'

/**
 * The two import buttons, driven the way somebody with an account drives them.
 *
 * pathofexile.com is stood in for, and only pathofexile.com: the dev server's
 * /poe routes answer from the fixture and everything below them is real, so
 * this exercises the browser, the bridge and PoB in one go.
 *
 * What it is really watching is the resistance penalty. A character partway
 * through the campaign used to import as though it had finished the game,
 * which took 60% off every elemental resistance and showed up here, in the
 * sidebar, as a build that looked broken.
 */

const envelope = readFileSync(
  fileURLToPath(new URL('../engine/fixtures/character.json', import.meta.url)),
  'utf8',
)
const character = JSON.parse(envelope).character as {
  name: string
  class: string
  level: number
}

/** The value PoB shows against one of the sidebar's labels. */
const statValue = (page: import('@playwright/test').Page, label: string) =>
  page.locator(
    `[class*="row"]:has(> [class*="label"]:text-is("${label}")) [class*="value"]`,
  )

const asNumber = async (locator: ReturnType<typeof statValue>) =>
  Number.parseFloat(((await locator.innerText()) || '').replace('%', '').replace(/,/g, ''))

test.describe('importing a character from an account', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/poe/status', (route) =>
      route.fulfill({
        json: { authenticated: true, signInPending: false, expiresAt: null, error: null },
      }),
    )
    await page.route('**/poe/characters', (route) =>
      route.fulfill({
        json: {
          characters: [
            {
              name: character.name,
              class: character.class,
              level: character.level,
              league: 'Standard',
              current: true,
              expired: false,
              deleted: false,
            },
          ],
        },
      }),
    )
    // Forwarded to the engine untouched, exactly as the dev server would.
    await page.route('**/poe/character?*', (route) =>
      route.fulfill({ contentType: 'application/json', body: envelope }),
    )
  })

  // The engine behind these tests is shared, so hand the next spec a build it
  // has not been given a character.
  test.afterEach(async ({ page }) => {
    await page.request.post('/bridge/build/new', { data: {} })
  })

  test('both buttons import, and the resistances read the way the game does', async ({
    page,
    watch,
  }) => {
    await openApp(page)
    await openView(page, 'Import')

    await page.getByRole('button', { name: 'Items and Skills' }).click()
    await expect(page.getByText('Items and skills imported.')).toBeVisible()
    await page.getByRole('button', { name: 'Passive Tree and Jewels' }).click()
    await expect(page.getByText('Passive tree and jewels imported.')).toBeVisible()

    // Polled rather than read once: the sidebar follows the engine a beat
    // behind, and the number before the import is a negative one.
    for (const element of ['Fire', 'Cold', 'Lightning']) {
      const value = statValue(page, `${element} Resistance`)
      await expect(value).toBeVisible()
      await expect
        .poll(() => asNumber(value), {
          message: `${element} resistance is positive, not the Endgame penalty`,
        })
        .toBeGreaterThan(0)
    }

    // And the Config tab agrees: the penalty matches PoB's own act estimate,
    // so the notice that says they disagree is not there.
    await openView(page, 'Config')
    await expect(page.getByText(/the elemental resistance penalty is set to/)).toHaveCount(0)

    expect(watch.errors).toEqual([])
  })
})
