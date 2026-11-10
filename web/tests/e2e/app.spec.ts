import { expect, openApp, openView, test, VIEWS } from './fixtures'

test.describe('the app', () => {
  test('loads and the left sidebar shows stats', async ({ page, watch }) => {
    await openApp(page)
    const sidebar = page.locator('aside')
    await expect(sidebar.getByText('Total Life', { exact: true })).toBeVisible()
    await expect(sidebar.getByText('Fire Resistance', { exact: true })).toBeVisible()
    expect(watch.errors).toEqual([])
  })

  for (const [label] of VIEWS) {
    test(`the ${label} view opens without a console error`, async ({ page, watch }) => {
      await openApp(page)
      await openView(page, label)
      // Views fetch from the engine on open; give them time to settle
      // before judging the console.
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(1500)
      await expect(page.getByText(/something went wrong|Unhandled|Application error/i)).toHaveCount(0)
      expect(watch.errors).toEqual([])
    })
  }
})
