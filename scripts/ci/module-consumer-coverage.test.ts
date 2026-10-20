import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { checkModuleConsumerCoverage } from './check-module-consumer-coverage.mjs'
import { createConsumerDependencyReader } from './consumer-retirement.mjs'
import * as consumerSources from './generate-module-derived-consumers.mjs'
import * as moduleImpact from './load-module-impact.mjs'
import * as derivedConsumers from './module-derived-consumers.mjs'

afterEach(() => vi.restoreAllMocks())

it.each(['skill_package', 'specialist_package'])(
  'retains conservative %s consumers without permitting missing dependency coverage',
  (id) => {
    const owner = 'packages/example/src/index.ts'
    const historical = 'src/host.test.ts'
    const added = 'src/new-consumer.test.ts'
    const manifest = {
      schemaVersion: 1,
      modules: {
        [id]: {
          ownerPaths: [owner],
          interfacePaths: [owner],
          testFiles: { owner: [], contract: [], consumer: [historical] }
        }
      }
    }
    const derived = { schemaVersion: 1, modules: {} }
    const contents = new Map([
      [owner, 'export const value = 1'],
      [historical, 'export const fixture = 1'],
      ['scripts/ci/module-runtime-consumers.json', '{}'],
      ['scripts/ci/module-derived-consumers.json', JSON.stringify(derived)]
    ])
    const source = { files: new Set(contents.keys()), read: (path: string) => contents.get(path) }
    vi.spyOn(consumerSources, 'workingConsumerSource').mockReturnValue(source)
    vi.spyOn(moduleImpact, 'loadModuleImpactManifest').mockReturnValue(manifest)
    vi.spyOn(derivedConsumers, 'loadDerivedConsumers').mockReturnValue(derived)
    expect(createConsumerDependencyReader(source, [])(historical, new Set([owner]))).toEqual({
      reachable: false,
      complete: true
    })
    // Current independence cannot authorize deleting an opaque historical host contract.
    expect(() => checkModuleConsumerCoverage()).not.toThrow()

    source.files.add(added)
    contents.set(added, "import { value } from '../packages/example/src/index'")
    expect(() => checkModuleConsumerCoverage()).toThrow('Stale derived consumer index')

    contents.set(added, 'export const fixture = 2')
    contents.set('scripts/ci/module-runtime-consumers.json', JSON.stringify({ [owner]: [added] }))
    expect(() => checkModuleConsumerCoverage()).toThrow('Stale derived consumer index')
  }
)

// Whole-tree TypeScript parsing is a structural guard, outside the application's coverage scope.
// Run the same assertions without inheriting Vitest's V8 profiler: precise coverage makes this
// scan exceed 120 seconds even when the uninstrumented guard finishes in a fraction of that time.
it('retains every statically reachable consumer test and declared runtime-loading edge', () => {
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { checkModuleConsumerCoverage } from './scripts/ci/check-module-consumer-coverage.mjs'; checkModuleConsumerCoverage()`
    ],
    { cwd: process.cwd(), timeout: 110_000, stdio: 'pipe' }
  )
}, 120_000)
