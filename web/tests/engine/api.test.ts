import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { startEngine, type Engine } from './harness'

let engine: Engine

// One engine for the whole file: it takes seconds to boot and the tests
// below are written so they do not depend on each other's leftovers.
beforeAll(async () => {
  engine = await startEngine()
}, 180_000)

afterAll(() => {
  engine?.stop()
})

const resistancePenalty = async () => {
  const { body } = await engine.get('/config')
  const opt = body.sections.flatMap((s: any) => s.options).find((o: any) => o.var === 'resistancePenalty')
  expect(opt, 'resistancePenalty option is shown').toBeTruthy()
  return opt.value as number
}

describe('GET /health', () => {
  it('answers, is booted and has a build open', async () => {
    const { status, body } = await engine.get('/health')
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.booted).toBe(true)
    expect(body.buildOpen).toBe(true)
    expect(body.promptMsg ?? null).toBeNull()
  })

  it('lists the newer commands', async () => {
    const { body } = await engine.get('/health')
    expect(body.commands).toEqual(
      expect.arrayContaining(['importCharacter', 'estimateResistancePenalty', 'importCodeHere', 'setExportBuffs']),
    )
  })
})

describe('importCharacter refuses bad input without touching the build', () => {
  const NAME = 'Guard build'
  const LEVEL = 42
  const ok = '{"class":"Ranger","equipment":[],"passives":{"hashes":[]}}'

  const snapshot = async () => {
    const { body } = await engine.get('/state')
    return { name: body.buildName, level: body.characterLevel, classId: body.classId }
  }

  beforeAll(async () => {
    expect((await engine.action('setBuildName', NAME)).status).toBe(200)
    expect((await engine.action('setLevelAutoMode', false)).status).toBe(200)
    expect((await engine.action('setCharacterLevel', LEVEL)).status).toBe(200)
    const before = await snapshot()
    expect(before.name).toBe(NAME)
    expect(before.level).toBe(LEVEL)
  })

  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['no json', {}, /expected \{ json/],
    ['tree:false and items:false', { json: ok, tree: false, items: false }, /nothing to import/],
    ['items asked for, no equipment key', { json: '{"class":"Ranger","passives":{"hashes":[]}}', tree: false }, /no equipment list/],
    ['tree asked for, no passives', { json: '{"class":"Ranger","equipment":[]}', items: false }, /no passive data/],
    ['no class', { json: '{"equipment":[],"passives":{"hashes":[]}}', items: false }, /no class/],
  ]

  it.each(cases)('%s', async (_label, value, message) => {
    const before = await snapshot()
    const { status, body } = await engine.action('importCharacter', value)
    expect(status).toBe(400)
    expect(body.error).toMatch(message)
    // The point: PoB deletes before it validates, so a refusal that came
    // too late would have emptied the build.
    expect(await snapshot()).toEqual(before)
    const health = (await engine.get('/health')).body
    expect(health.promptMsg ?? null).toBeNull()
  })
})

describe('saveBuildAs', () => {
  const name = `zz-engine-test-${Date.now()}`

  it('refuses a missing name and writes nothing', async () => {
    const before = (await engine.get('/builds')).body.entries.length
    const { status, body } = await engine.action('saveBuildAs', {})
    expect(status).toBe(400)
    expect(body.error).toMatch(/needs a name/)
    expect((await engine.get('/builds')).body.entries.length).toBe(before)
  })

  it('writes a file when given a name', async () => {
    const { buildPath } = (await engine.get('/paths')).body
    // Safety: only ever look inside the throwaway builds folder.
    const norm = (p: string) => p.split(String.fromCharCode(92)).join('/')
    expect(norm(buildPath)).toContain(norm(engine.userPath))
    const file = `${buildPath}${name}.xml`
    expect(existsSync(file)).toBe(false)

    const { status, body } = await engine.action('saveBuildAs', { name })
    expect(status).toBe(200)
    expect(body.buildName).toBe(name)
    expect(existsSync(file)).toBe(true)

    const list = (await engine.get('/builds')).body.entries
    expect(list.some((e: any) => e.kind === 'build' && e.name === name)).toBe(true)

    // A second save under the same name is refused rather than overwritten.
    const again = await engine.action('saveBuildAs', { name })
    expect(again.status).toBe(400)
    expect(again.body.error).toMatch(/already a build called/)
  })
})

describe('GET /state carries the game data version', () => {
  it('reports the tree and target the engine is running on', async () => {
    const { body } = await engine.get('/state')
    // PoB's own globals from GameVersions.lua. A number computed against
    // last patch's tree is wrong in a way no stat line shows, so the
    // version has to travel with the numbers.
    expect(body.data.tree).toMatch(/^\d+_\d+$/)
    expect(body.data.target).toMatch(/^\d+_\d+$/)
    expect(body.data.buildTree).toBe(body.data.tree)
  })
})

describe('the stat set a skill is measured on', () => {
  it('lists both of a two-set skill, and the sheet follows the one selected', async () => {
    expect((await engine.post('/build/new')).status).toBe(200)

    // Essence Drain is the plain case: PoB's data gives it a "Projectile"
    // stat set and a "Damage over Time" one, and calculates whichever is
    // selected and no other. Until the bridge carried the selector, a build
    // whose damage is the debuff read as the projectile's hit with nothing
    // saying a second set existed.
    const gems = (await engine.get('/gems/search?q=Essence+Drain')).body.results
    const gem = gems.find((entry: any) => entry.name === 'Essence Drain')
    expect(gem, "PoB's data has Essence Drain").toBeTruthy()
    expect((await engine.action('addSocketGroup')).status).toBe(200)
    expect((await engine.action('addGem', { group: 1, gem: gem.id })).status).toBe(200)

    const first = (await engine.get('/stats')).body
    expect(first.statSets.map((set: any) => set.name)).toEqual([
      'Projectile',
      'Damage over Time',
    ])
    expect(first.statSetId).toBe(1)
    const dotLines = (lines: any[]) =>
      lines.filter((line: any) => /DoT/i.test(line.label)).map((line: any) => line.label)
    expect(dotLines(first.lines), 'the projectile set has no damage over time').toEqual([])

    expect((await engine.action('setStatSet', 2)).status).toBe(200)
    const second = (await engine.get('/stats')).body
    expect(second.statSetId).toBe(2)
    expect(dotLines(second.lines).length, 'the other set has it').toBeGreaterThan(0)

    // And back, because the selection is a view on the gem rather than a
    // change to the build, and a caller may well want it where it was.
    expect((await engine.action('setStatSet', 1)).status).toBe(200)
    expect((await engine.get('/stats')).body.statSetId).toBe(1)
  })

  it('refuses an option that is not there', async () => {
    const { status, body } = await engine.action('setStatSet', 99)
    expect(status).toBe(400)
    expect(body.error).toMatch(/no option 99/)
  })
})

describe('the revision clients refetch on', () => {
  it('moves when a build is opened, though PoB sets its own counter back to 1', async () => {
    // A build on disk with something in it, so opening it is a real change.
    const name = `zz-revision-${Date.now()}`
    expect((await engine.action('setCharacterLevel', 55)).status).toBe(200)
    expect((await engine.action('saveBuildAs', { name })).status).toBe(200)
    const listed = (await engine.get('/builds')).body.entries
      .find((e: any) => e.kind === 'build' && e.name === name)
    expect(listed, 'the build was written').toBeTruthy()

    expect((await engine.post('/build/new')).status).toBe(200)
    const before = (await engine.get('/state')).body.outputRevision

    expect((await engine.post('/build/open', { path: listed.path })).status).toBe(200)
    const after = (await engine.get('/state')).body
    expect(after.buildName).toBe(name)
    expect(after.characterLevel).toBe(55)

    // The trap this guards: buildMode:Init sets PoB's outputRevision back
    // to 1, so on an engine that has not recalculated since it booted,
    // opening a build left the number exactly where it was and every view
    // that refetches when it moves went on showing the build before it.
    expect(after.outputRevision).not.toBe(before)
  })

  it('does not move when nothing has changed', async () => {
    const first = (await engine.get('/state')).body.outputRevision
    const second = (await engine.get('/state')).body.outputRevision
    expect(second).toBe(first)
  })
})

describe('estimateResistancePenalty', () => {
  it('sets the penalty from the act on a fresh empty build', async () => {
    expect((await engine.post('/build/new')).status).toBe(200)
    // Move it off whatever it is so the command has something to do.
    const wrong = await engine.action('setConfig', { var: 'resistancePenalty', value: -60 })
    expect(wrong.status).toBe(200)

    const { status } = await engine.action('estimateResistancePenalty')
    expect(status).toBe(200)

    const act: string = (await engine.get('/state')).body.act
    expect(act).toMatch(/^(Act \d+|Endgame)$/)
    const expected = act === 'Endgame' ? -60 : 10 * (1 - Number(act.replace('Act ', '')))
    expect(await resistancePenalty()).toBe(expected)
  })
})
