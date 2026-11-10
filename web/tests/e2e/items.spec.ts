import { engineGet, expect, openApp, openView, test } from './fixtures'

const ITEM = [
  'Rarity: Rare',
  'Dread Loop',
  'Iron Ring',
  '--------',
  'Item Level: 20',
  '--------',
  '+17 to maximum Life',
].join('\n')

test('Ctrl+V of game item text on the Items view puts the item on the bench', async ({ page, watch }) => {
  await openApp(page)
  await openView(page, 'Items')
  // Let the view mount and attach its paste listener.
  await page.waitForLoadState('networkidle')

  await page.evaluate((text) => {
    const data = new DataTransfer()
    data.setData('text/plain', text)
    // Dispatched on body, as a real paste is: the target is an element, and
    // the handler's own filter ignores pastes into text fields.
    document.body.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
  }, ITEM)

  await expect(page.getByText('Dread Loop').first()).toBeVisible()
  // And the engine agrees it is staged.
  await expect
    .poll(async () => JSON.stringify(await engineGet(page, '/item/staged')))
    .toContain('Dread Loop')
  expect(watch.errors).toEqual([])
})
