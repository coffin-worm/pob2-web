import { readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { userPath } from './playwright.config'
import { engineGet, expect, openApp, openView, test } from './fixtures'

const norm = (p: string) => p.split(String.fromCharCode(92)).join('/')
const name = `zz-e2e-save-${Date.now()}`
const file = path.join(userPath, 'Path of Building (PoE2)', 'Builds', `${name}.xml`)
const openName = `zz-e2e-open-${Date.now()}`
const openFile = path.join(userPath, 'Path of Building (PoE2)', 'Builds', `${openName}.xml`)

test.afterAll(() => {
  // Only ever the files these tests made, and inside the throwaway folder.
  for (const victim of [file, openFile]) {
    try { rmSync(victim, { force: true }) } catch { /* best effort */ }
  }
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

test('opening a saved build fills the tree', async ({ page, watch }) => {
  // A build with a tree in it, saved, and then put away again: the state
  // somebody is in when they open the app and pick a build from the list.
  const character = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../engine/fixtures/character.json', import.meta.url)),
      'utf8',
    ),
  ).character

  await page.request.post('/bridge/build/new', { data: {} })
  await page.request.post('/bridge/action', {
    data: { action: 'importCharacter', value: { json: JSON.stringify(character) } },
  })
  await page.request.post('/bridge/action', { data: { action: 'saveBuildAs', value: { name: openName } } })
  await page.request.post('/bridge/build/new', { data: {} })

  await openApp(page)
  await openView(page, 'Builds')
  await page.getByText(openName).first().click()
  // The header is the first thing to say the build changed.
  await expect(page.getByRole('button', { name: `Save ${openName}` })).toBeVisible()

  await openView(page, 'Tree')

  // The engine's own count, so the class start node cannot make this
  // off by one, and the tree is asserted to agree with it.
  const alloc = await engineGet(page, '/tree/alloc')
  expect(alloc.allocated.length, 'the build really has a tree').toBeGreaterThan(
    character.passives.hashes.length,
  )

  // The bug this is here for: PoB sets its own outputRevision back to 1
  // when it opens a build, so a view that refetches when that number moves
  // saw no move and went on drawing the build before it. An empty one, as
  // it happens, which is a tree with nothing on it.
  await expect(page.getByText(`${alloc.allocated.length} allocated`)).toBeVisible()
  expect(watch.errors).toEqual([])
})
