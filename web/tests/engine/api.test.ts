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
