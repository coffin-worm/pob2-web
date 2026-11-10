import { rmSync } from 'node:fs'
import path from 'node:path'
import { userPath } from './playwright.config'
import { engineGet, expect, openApp, openView, test } from './fixtures'

const norm = (p: string) => p.split(String.fromCharCode(92)).join('/')
const name = `zz-e2e-save-${Date.now()}`
const file = path.join(userPath, 'Path of Building (PoE2)', 'Builds', `${name}.xml`)

test.afterAll(() => {
  // Only ever the one file this test made, and inside the throwaway folder.
  try { rmSync(file, { force: true }) } catch { /* best effort */ }
})

test('typing a name and pressing Save a copy creates the build', async ({ page, watch }) => {
  await openApp(page)
  await openView(page, 'Builds')

  const saveCopy = page.getByRole('button', { name: 'Save a copy' })
  await expect(saveCopy).toBeDisabled()

  await page.getByLabel('New build name').fill(name)
  await expect(saveCopy).toBeEnabled()
  await saveCopy.click()

  // The list shows it, and the engine has it on disk.
  await expect(page.getByText(name).first()).toBeVisible()
  const builds = await engineGet(page, '/builds')
  const entry = builds.entries.find((e: { kind: string; name: string }) => e.kind === 'build' && e.name === name)
  expect(entry, 'the build is listed by the engine').toBeTruthy()
  expect(norm(entry.path)).toBe(norm(file))
  expect(norm(builds.openPath)).toBe(norm(file))
  // The name box is cleared once it has saved.
  await expect(page.getByLabel('New build name')).toHaveValue('')
  expect(watch.errors).toEqual([])
})
