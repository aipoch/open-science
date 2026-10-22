/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { moduleOwnershipFromRevisions } from './check-module-ownership.mjs'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const value = 'src/shared/value.ts'
const valueTest = 'src/shared/value.test.ts'
const channel = 'src/shared/channel.ts'
const format = 'src/shared/format.ts'
const impure = 'src/shared/impure.ts'
const consumer = 'src/main/consumer.ts'
const consumerTest = 'src/main/consumer.test.ts'
const hostContract = 'src/main/ipc.test.ts'
const scriptContract = 'scripts/contract.test.ts'
const reader = 'src/main/literature/pdf-translation/reader.ts'
const readerTest = 'src/main/literature/pdf-translation/reader.test.ts'
const fixtureData = 'test/fixtures/pdf-translation/case.jsonl'
const unroutedData = 'test/fixtures/unrouted/case.json'

type Module = {
  ownerPaths: string[]
  interfacePaths: string[]
  testFiles: { owner: string[]; contract: string[]; consumer: string[] }
  consumerModules: string[]
  capabilityOverlays: string[]
  fallbackCapability: string
  fullTestReason?: string
}

function fixture(sources: Record<string, string> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'full-owner-split-'))
  roots.push(cwd)
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), text)
  }
  const commit = () => {
    git('add', '.')
    git('commit', '-qm', 'fixture')
    return git('rev-parse', 'HEAD')
  }
  const module = (ownerPaths: string[], owner: string[], fallbackCapability: string): Module => ({
    ownerPaths,
    interfacePaths: [ownerPaths[0]],
    testFiles: { owner, contract: [], consumer: [] },
    consumerModules: [],
    capabilityOverlays: [],
    fallbackCapability
  })
  const shared = module(
    [value, valueTest, channel, format, impure, fixtureData, unroutedData],
    [valueTest],
    'shared_contract'
  )
  shared.interfacePaths = [value, channel, format, impure]
  shared.testFiles.contract = [hostContract, scriptContract]
  shared.consumerModules = ['host']
  shared.fullTestReason = 'Shared contracts have dynamic consumers.'
  const manifest: { schemaVersion: number; modules: Record<string, Module> } = {
    schemaVersion: 1,
    modules: {
      shared,
      host: module(
        [consumer, consumerTest, hostContract],
        [consumerTest, hostContract],
        'main_runtime'
      ),
      reader: module([reader, readerTest], [readerTest], 'main_runtime')
    }
  }
  const save = () => put('scripts/ci/module-impact.json', JSON.stringify(manifest))
  git('init', '-q')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  put(value, 'export const value = 1')
  put(valueTest, "import './value'")
  put(channel, "export const OPEN_CHANNEL = 'example:open'")
  put(format, 'export const schemaVersion = 1')
  put(impure, 'export const home = () => process.env.HOME')
  put(consumer, "export { value } from '../shared/value'")
  put(consumerTest, "import './consumer'")
  put(hostContract, 'export {}')
  put(scriptContract, 'export {}')
  put(reader, 'export const read = () => 1')
  put(readerTest, "import './reader'")
  put(fixtureData, '{}\n')
  put(unroutedData, '{}\n')
  put('scripts/ci/module-runtime-consumers.json', '{}')
  for (const [path, text] of Object.entries(sources)) put(path, text)
  save()
  const base = commit()
  // Move one static contract to a new owner and its unproven evidence along with it.
  const split = (paths = [value, valueTest], id = 'values') => {
    manifest.modules[id] = {
      ownerPaths: paths,
      interfacePaths: paths.filter((path) => !path.endsWith('.test.ts')),
      testFiles: {
        owner: paths.filter((path) => path.endsWith('.test.ts')),
        contract: [],
        consumer: [scriptContract]
      },
      consumerModules: ['host'],
      capabilityOverlays: [],
      fallbackCapability: 'shared_contract'
    }
    shared.ownerPaths = shared.ownerPaths.filter((path) => !paths.includes(path))
    shared.interfacePaths = shared.interfacePaths.filter((path) => !paths.includes(path))
    shared.testFiles.owner = shared.testFiles.owner.filter((path) => !paths.includes(path))
    return manifest.modules[id]
  }
  const check = () => {
    save()
    return moduleOwnershipFromRevisions(base, commit(), { cwd })
  }
  return { put, manifest, shared, split, check }
}

const rejected = (result: ReturnType<typeof moduleOwnershipFromRevisions>) =>
  result.violations.map(({ message }) => message).join('\n')

it('moves a static shared contract out of a full owner with reachable and unproven evidence', () => {
  const state = fixture()
  state.split()
  state.shared.fullTestReason = 'Remaining contracts are addressed by channel name.'
  const result = state.check()
  expect(result.violations).toEqual([])
  expect(result.boundedOwnerSplits).toEqual(
    expect.arrayContaining([`shared:${value}`, `shared:${valueTest}`])
  )
})

it('admits a dynamic surface only into a new full owner', () => {
  const dynamic = fixture()
  dynamic.split([channel], 'names')
  expect(rejected(dynamic.check())).toContain('shared.ownerPaths')

  const full = fixture()
  full.split([channel], 'names').fullTestReason = 'Channel names are dispatched by value.'
  expect(full.check().violations).toEqual([])
})

it.each([
  ['a persisted-format marker', format],
  ['an opaque runtime dependency', impure]
])('keeps %s on the full owner', (_, path) => {
  const state = fixture()
  state.split([path])
  expect(rejected(state.check())).toContain('shared.ownerPaths')
})

it.each([
  ['an interpolated channel name', 'export const channel = (id: string) => `example:${id}`'],
  ['a channel suffix after interpolation', 'export const channel = (id: string) => `${id}:open`'],
  [
    'a plain event name passed to an event API',
    "export const notify = (bus: { emit(name: string): void }) => bus.emit('session-updated')"
  ],
  [
    'a local event-name constant passed to an event API',
    "const UPDATED = 'session-updated'\nexport const notify = (bus: { send(name: string): void }) => bus.send(UPDATED)"
  ],
  ['a constructed DOM event', "export const event = () => new CustomEvent('session-updated')"],
  [
    'a computed event API call',
    "export const notify = (bus: Record<string, (name: string) => void>) => bus['emit']('session-updated')"
  ],
  [
    'a destructured IPC call',
    "export const ask = ({ invoke }: { invoke(name: string): void }) => invoke('session-updated')"
  ],
  [
    'a qualified event constructor',
    "export const event = (dom: { CustomEvent: typeof CustomEvent }) => new dom.CustomEvent('session-updated')"
  ]
])('keeps %s on the full owner', (_, text) => {
  const state = fixture({ [channel]: text })
  state.split([channel], 'names')
  expect(rejected(state.check())).toContain('shared.ownerPaths')
})

it('still moves ordinary kebab-case values that are not dispatched by name', () => {
  const state = fixture({
    [value]: "export const kinds = ['project-file', 'image-point'] as const"
  })
  state.split()
  expect(state.check().violations).toEqual([])
})

it('retains explicit contracts that have no static path from the original sources', () => {
  const state = fixture()
  state.split().testFiles.consumer = [consumerTest]
  expect(rejected(state.check())).toContain('shared.ownerPaths')
})

it.each([
  [
    'drops the remaining full marker',
    (state: ReturnType<typeof fixture>) => delete state.shared.fullTestReason
  ],
  [
    'drops a remaining contract',
    (state: ReturnType<typeof fixture>) => (state.shared.testFiles.contract = [scriptContract])
  ],
  [
    'drops a downstream module edge',
    (state: ReturnType<typeof fixture>) => (state.manifest.modules.values.consumerModules = [])
  ],
  [
    'changes fallback routing',
    (state: ReturnType<typeof fixture>) =>
      (state.manifest.modules.values.fallbackCapability = 'main_runtime')
  ],
  [
    'edits the moved source',
    (state: ReturnType<typeof fixture>) => state.put(value, 'export const value = 2')
  ],
  [
    'declares a runtime edge in the same revision',
    (state: ReturnType<typeof fixture>) =>
      state.put('scripts/ci/module-runtime-consumers.json', JSON.stringify({ [value]: [consumer] }))
  ]
])('rejects a split that %s', (_, mutate) => {
  const state = fixture()
  state.split()
  mutate(state)
  expect(state.check().ok).toBe(false)
})

it('rejects source transfers into an existing module', () => {
  const state = fixture()
  state.shared.ownerPaths = state.shared.ownerPaths.filter((path) => path !== value)
  state.shared.interfacePaths = state.shared.interfacePaths.filter((path) => path !== value)
  const host = state.manifest.modules.host
  host.ownerPaths.push(value)
  host.interfacePaths.push(value)
  host.testFiles.consumer.push(scriptContract)
  expect(rejected(state.check())).toContain('shared.ownerPaths')
})

it('moves routed regression data to its reader owner but not unrouted data', () => {
  const routed = fixture()
  routed.shared.ownerPaths = routed.shared.ownerPaths.filter((path) => path !== fixtureData)
  routed.manifest.modules.reader.ownerPaths.push(fixtureData)
  expect(routed.check().violations).toEqual([])

  const unrouted = fixture()
  unrouted.shared.ownerPaths = unrouted.shared.ownerPaths.filter((path) => path !== unroutedData)
  unrouted.manifest.modules.reader.ownerPaths.push(unroutedData)
  expect(rejected(unrouted.check())).toContain('shared.ownerPaths')
})

it('rejects a reworded full marker without a verified split', () => {
  const state = fixture()
  state.shared.fullTestReason = 'Reworded without moving anything.'
  expect(rejected(state.check())).toContain('shared.fullTestReason')
})
