/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { moduleOwnershipFromRevisions } from './check-module-ownership.mjs'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
describe.each([
  ['pdf_text', 'pdf-text', true],
  ['shared_promise_identity', 'in-flight-promise', true],
  ['shared_fuzzy_match', 'fuzzy-match', false]
] as const)('%s boundary', (moduleId, file, includeOwnerTest) => {
  const source = `src/shared/${file}.ts`
  const test = `src/shared/${file}.test.ts`
  const consumer = includeOwnerTest
    ? 'src/consumer.test.ts'
    : 'src/renderer/src/pages/workspace/composer/fuzzy-match.test.ts'
  const uncertain = 'src/runtime.test.ts'

  function fixture(
    implementation = 'export const joinPdfTextItems = () => "text"',
    independentContract = false
  ) {
    const cwd = mkdtempSync(join(tmpdir(), 'pdf-owner-split-'))
    roots.push(cwd)
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
    const put = (path: string, text: string) => {
      mkdirSync(dirname(join(cwd, path)), { recursive: true })
      writeFileSync(join(cwd, path), text)
    }
    const module = (paths: string[], tests: string[]) => ({
      ownerPaths: paths,
      interfacePaths: [paths[0]],
      consumerModules: [],
      capabilityOverlays: ['windows_sensitive'],
      fallbackCapability: 'main_runtime',
      testFiles: { owner: tests, contract: [] as string[], consumer: [] as string[] }
    })
    const original = {
      ...module(
        [source, ...(includeOwnerTest ? [test] : []), 'src/shared/other.ts'],
        includeOwnerTest ? [test] : []
      ),
      fullTestReason: 'Dynamic cross-process contracts'
    }
    original.testFiles.contract.push(consumer)
    const host = module(
      [consumer, uncertain, ...(!includeOwnerTest ? [test] : [])],
      [consumer, uncertain, ...(!includeOwnerTest ? [test] : [])]
    )
    if (independentContract) {
      original.testFiles.contract.push('src/independent.test.ts')
      host.ownerPaths.push('src/independent.test.ts')
      host.testFiles.owner.push('src/independent.test.ts')
      put('src/independent.test.ts', "import './shared/other'")
    }
    const save = (id: string, value: object) =>
      put(`scripts/ci/module-impact/${id}.json`, JSON.stringify(value))
    const commit = () => {
      git('add', '.')
      git('commit', '-qm', 'fixture')
      return git('rev-parse', 'HEAD')
    }
    git('init', '-q')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.test')
    put('scripts/ci/module-impact.json', '{"schemaVersion":1}')
    put('scripts/ci/module-runtime-consumers.json', '{}')
    put(
      'scripts/ci/package-test-boundaries.json',
      JSON.stringify({
        schemaVersion: 1,
        packages: [{ root: 'packages/independent', dependencies: [] }]
      })
    )
    put(
      'packages/independent/package.json',
      JSON.stringify({ name: '@example/independent', exports: { '.': './dist/index.js' } })
    )
    put('packages/independent/src/index.ts', 'export {}')
    put('packages/independent/unit.test.ts', 'process.env.EXAMPLE')
    save(
      'independent',
      module(
        ['packages/independent/src/index.ts', 'packages/independent/unit.test.ts'],
        ['packages/independent/unit.test.ts']
      )
    )
    save('shared_application_contracts', original)
    save('host', host)
    put(source, implementation)
    put(test, `import './${file}'`)
    put('src/shared/other.ts', 'export {}')
    put(consumer, `import './${relative(dirname(consumer), source).replaceAll('\\', '/')}'`)
    put(uncertain, 'import(moduleName)')
    const base = commit()
    const remaining = {
      ...original,
      ownerPaths: ['src/shared/other.ts'],
      interfacePaths: ['src/shared/other.ts']
    }
    const target = module(
      [source, ...(includeOwnerTest ? [test] : [])],
      includeOwnerTest ? [test] : []
    )
    target.testFiles.consumer = [consumer, uncertain, ...(!includeOwnerTest ? [test] : [])]
    const inspect = () => {
      save('shared_application_contracts', remaining)
      save(moduleId, target)
      return moduleOwnershipFromRevisions(base, commit(), { cwd })
    }
    return { put, remaining, target, inspect }
  }

  it('admits only the reviewed metadata-only pure-helper split and reports its exact transferred paths', () => {
    expect(fixture().inspect()).toMatchObject({
      ok: true,
      boundedOwnerSplits: [
        `shared_application_contracts:${source}`,
        ...(includeOwnerTest ? [`shared_application_contracts:${test}`] : [])
      ]
    })
  })

  it.each([consumer, uncertain])(
    'rejects losing reachable or uncertain consumer evidence: %s',
    (path) => {
      const state = fixture()
      state.target.testFiles.consumer = state.target.testFiles.consumer.filter(
        (test) => test !== path
      )
      expect(state.inspect().ok).toBe(false)
    }
  )

  it('rejects changing source or tests together with the transfer', () => {
    for (const path of [source, test, consumer, 'scripts/ci/package-test-boundaries.json']) {
      const state = fixture()
      state.put(path, 'export {}')
      expect(state.inspect().ok).toBe(false)
    }
  })

  if (!includeOwnerTest)
    it('requires the existing composer behavior suite specifically as consumer evidence', () => {
      const state = fixture()
      state.target.testFiles.consumer = state.target.testFiles.consumer.filter(
        (path) => path !== consumer
      )
      state.target.testFiles.contract.push(consumer)
      expect(state.inspect().ok).toBe(false)
    })

  it('keeps independent shared contracts on the full owner while preserving legacy split rules', () => {
    const state = fixture(undefined, true)
    expect(state.inspect().ok).toBe(!includeOwnerTest)
  })

  if (!includeOwnerTest)
    it('rejects removing an independent contract from the remaining full owner', () => {
      const state = fixture(undefined, true)
      state.remaining.testFiles = {
        ...state.remaining.testFiles,
        contract: state.remaining.testFiles.contract.filter(
          (path) => path !== 'src/independent.test.ts'
        )
      }
      expect(state.inspect().ok).toBe(false)
    })

  it('rejects a pure-looking utility with unbounded runtime inputs', () => {
    expect(
      fixture(
        "import { readFileSync } from 'node:fs'; export const text = readFileSync('input')"
      ).inspect().ok
    ).toBe(false)
  })

  it.each(['marker', 'old-tests', 'overlay', 'fallback', 'interface', 'owner-test'])(
    'preserves ordinary obligations during the exception: %s',
    (field) => {
      const state = fixture()
      if (field === 'marker') state.remaining.fullTestReason = 'weakened reason'
      if (field === 'old-tests')
        state.remaining.testFiles = { owner: [consumer], contract: [], consumer: [] }
      if (field === 'overlay') state.target.capabilityOverlays = []
      if (field === 'fallback') state.target.fallbackCapability = 'documentation'
      if (field === 'interface') state.target.interfacePaths = [test]
      if (field === 'owner-test')
        state.target.testFiles = { owner: [consumer], contract: [], consumer: [uncertain] }
      expect(state.inspect().ok).toBe(false)
    }
  )
})
