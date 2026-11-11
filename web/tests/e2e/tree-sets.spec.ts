import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, openApp, openView, test } from './fixtures'

/**
 * Weapon set passives, on the tree.
 *
 * A node paid for out of one weapon set's points is allocated like any
 * other, so it used to be drawn like any other and there was no way to tell
 * the two apart. What the canvas does about that cannot be asserted from a
 * pixel, but the count in the tree's own HUD comes from the same map the
 * rings and the connectors are drawn from: if it is right, the tree was
 * told.
 */

const character = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../engine/fixtures/character.json', import.meta.url)),
    'utf8',
  ),
).character

test.describe('weapon set passives', () => {
  // The engine is shared, so leave the next spec a build without one.
  test.afterEach(async ({ page }) => {
    await page.request.post('/bridge/build/new', { data: {} })
  })

  test('the tree counts them set by set', async ({ page, watch }) => {
    const importCharacter = (value: unknown) =>
      page.request.post('/bridge/action', {
        data: { action: 'importCharacter', value: { json: JSON.stringify(value) } },
      })

    // The fixture on its own first, to find out where its route can grow.
    await page.request.post('/bridge/build/new', { data: {} })
    expect((await importCharacter(character)).ok()).toBe(true)
    const alloc = await (await page.request.get('/bridge/tree/alloc')).json()
    const next = (alloc.reachable as [number, number][])
      .filter(([, cost]) => cost === 1)
      .map(([id]) => id)
      .sort((a, b) => a - b)
    const set1 = next.slice(0, 2)
    const set2 = next.slice(2, 5)
    expect(set2, 'the route has somewhere to grow').toHaveLength(3)

    await page.request.post('/bridge/build/new', { data: {} })
    expect(
      (
        await importCharacter({
          ...character,
          passives: { ...character.passives, specialisations: { set1, set2 } },
        })
      ).ok(),
    ).toBe(true)

    await openApp(page)
    await openView(page, 'Tree')

    // Two numbers that are not the same, so neither can be the other's.
    await expect(page.getByText(`${set1.length} Set I`, { exact: false })).toBeVisible()
    await expect(page.getByText(`${set2.length} Set II`, { exact: false })).toBeVisible()
    expect(watch.errors).toEqual([])
  })
})
