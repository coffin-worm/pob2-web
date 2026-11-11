import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { startEngine, type Engine } from './harness'

/**
 * Importing a character that is actually well formed.
 *
 * api.test.ts covers the refusals, which are the easy half: a payload PoB
 * cannot read has to be caught before PoB deletes anything. This file covers
 * the half that only ever ran by hand, against a live account: a payload
 * shaped like the real API's, imported into the build that is already open.
 *
 * The fixture is invented rather than recorded, so no account data is in the
 * repo, but every part of it is real to this checkout: the bases exist in
 * PoB's own data and the passive hashes are a route PoB itself worked out.
 * fixtures/character.json says how to regenerate them.
 */

const fixtureFile = fileURLToPath(new URL('./fixtures/character.json', import.meta.url))
const envelope = readFileSync(fixtureFile, 'utf8')
const character = JSON.parse(envelope).character as {
  name: string
  class: string
  level: number
  passives: { hashes: number[] }
  equipment: Array<{ name: string; typeLine: string }>
}

let engine: Engine

beforeAll(async () => {
  engine = await startEngine()
}, 180_000)

afterAll(() => {
  engine?.stop()
})

/** A fresh build, so one test cannot be read as another's leftovers. */
const freshBuild = async () => {
  expect((await engine.post('/build/new')).status).toBe(200)
}

const importFixture = (value: Record<string, unknown> = {}, json = envelope) =>
  engine.action('importCharacter', { json, ...value })

const resistancePenalty = async () => {
  const { body } = await engine.get('/config')
  const option = body.sections
    .flatMap((section: any) => section.options)
    .find((option: any) => option.var === 'resistancePenalty')
  expect(option, 'resistancePenalty option is shown').toBeTruthy()
  return option.value as number
}

/** One of the sidebar's own lines, as a number: "Fire Resistance" is "5%". */
const stat = async (label: string) => {
  const { body } = await engine.get('/stats')
  const line = body.lines.find((line: any) => line.label === label)
  expect(line, `${label} is in the stat list`).toBeTruthy()
  return Number.parseFloat(String(line.value).replace('%', '').replace(/,/g, ''))
}

/** The name of whatever is in a slot, or null. PoB names a rare "title, base". */
const equipped = async (slot: string) => {
  const { body } = await engine.get('/items')
  const found = body.slots.find((s: any) => s.name === slot)
  if (!found?.itemId) return null
  return body.items.find((item: any) => item.id === found.itemId)?.name ?? null
}

describe('importCharacter, with a payload shaped like the real one', () => {
  it('imports into the build that is already open', async () => {
    await freshBuild()
    const name = 'Keep this build'
    expect((await engine.action('setBuildName', name)).status).toBe(200)

    const { status, body } = await importFixture()
    expect(status).toBe(200)

    // The point of the command. POST /code/character goes through
    // HeadlessWrapper, which calls SetMode first and so always lands in a new
    // build; the desktop's two buttons import into the one you have.
    expect(body.buildName).toBe(name)
    expect(body.characterLevel).toBe(character.level)

    const classes: Array<{ id: number; name: string }> = body.classes
    const ranger = classes.find((c) => c.name === character.class)
    expect(ranger, `${character.class} is one of PoB's classes`).toBeTruthy()
    expect(body.classId).toBe(ranger!.id)

    // Also the canary for the fixture itself: if a tree update retires these
    // node ids, PoB allocates fewer than were asked for and this says so
    // rather than the tests quietly covering less than they claim to.
    expect(body.points.passives.used).toBe(character.passives.hashes.length)
  })

  it('equips the items and builds the socket group', async () => {
    await freshBuild()
    expect((await importFixture()).status).toBe(200)

    // The fixture wears one ring in each hand, which is also the only way to
    // see that inventoryId decides the slot rather than the order they arrive in.
    const slots = ['Ring 1', 'Ring 2']
    for (const [index, item] of character.equipment.entries()) {
      expect(await equipped(slots[index])).toBe(`${item.name}, ${item.typeLine}`)
    }

    const { body } = await engine.get('/skills')
    expect(body.groups).toHaveLength(1)
    expect(body.groups[0].label).toBe('Lightning Arrow')
    // The skill and the support gem socketed in it: the support arrives
    // without the " Support" in its name and PoB puts it back.
    expect(body.groups[0].gemCount).toBe(2)
  })

  it('leaves the resistance penalty on the act, not on Endgame', async () => {
    await freshBuild()
    expect((await importFixture()).status).toBe(200)

    // A character partway through the campaign. PoB's own estimate is the
    // subject here: the bug was that the import could not read it back, so
    // every import landed on Endgame whatever the tree said.
    const { body } = await engine.get('/state')
    expect(body.act).toMatch(/^Act \d+$/)
    const act = Number(body.act.replace('Act ', ''))
    expect(act).toBeGreaterThan(1)

    const penalty = await resistancePenalty()
    expect(penalty).toBe(-10 * (act - 1))
    expect(penalty).not.toBe(-60)

    // What that bug looked like to somebody reading the sidebar: the rings
    // give 25 each, so an Endgame penalty would show all three as negative.
    expect(await stat('Fire Resistance')).toBeGreaterThan(0)
    expect(await stat('Cold Resistance')).toBeGreaterThan(0)
    expect(await stat('Lightning Resistance')).toBeGreaterThan(0)
  })

  it('imports the tree on its own', async () => {
    await freshBuild()
    const { status, body } = await importFixture({ items: false })
    expect(status).toBe(200)
    expect(body.points.passives.used).toBe(character.passives.hashes.length)
    expect((await engine.get('/items')).body.items).toHaveLength(0)
  })

  it('imports the items on its own', async () => {
    await freshBuild()
    const { status, body } = await importFixture({ tree: false })
    expect(status).toBe(200)
    expect(body.points.passives.used).toBe(0)
    expect((await engine.get('/items')).body.items).toHaveLength(
      character.equipment.length,
    )
    expect(await equipped('Ring 1')).toBeTruthy()
  })

  it('takes the character on its own as well as inside the envelope', async () => {
    await freshBuild()
    const { status, body } = await importFixture({}, JSON.stringify(character))
    expect(status).toBe(200)
    expect(body.characterLevel).toBe(character.level)
    expect(body.points.passives.used).toBe(character.passives.hashes.length)
  })
})
