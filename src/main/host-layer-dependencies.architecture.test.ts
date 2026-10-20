import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error The repository's JavaScript evidence reader has no declaration file.
import { createConsumerDependencyReader } from '../../scripts/ci/consumer-retirement.mjs'
// @ts-expect-error The repository's JavaScript boundary checker has no declaration file.
import { boundaryViolations, dependencyLayer } from '../../scripts/ci/module-relationships.mjs'
import { loadModuleImpactManifest } from '../../scripts/ci/load-module-impact.mjs'

type Graph = Map<string, Set<string>>
const projectRoot = resolve(import.meta.dirname, '../..')
const lowerLayerBoundaries = new Map([
  ['notebook_execution_model', 'notebook_application'],
  ['settings_repository', 'settings_operations'],
  ['host_runtime_ports', 'main_cli_install']
])

function cycles(graph: Graph): string[] {
  const visited = new Set<string>()
  const active = new Set<string>()
  const stack: string[] = []
  const found = new Set<string>()
  function visit(source: string): void {
    visited.add(source)
    active.add(source)
    stack.push(source)
    for (const target of graph.get(source) ?? []) {
      if (!visited.has(target)) visit(target)
      else if (active.has(target))
        found.add([...stack.slice(stack.indexOf(target)), target].join(' -> '))
    }
    stack.pop()
    active.delete(source)
  }
  for (const source of graph.keys()) if (!visited.has(source)) visit(source)
  return [...found].sort()
}

function hostGraphs(overrides: Record<string, string> = {}): {
  structural: Graph
  runtimeModules: Graph
  consumerModules: Graph
  violations: string[]
} {
  const files = new Set<string>(
    execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: projectRoot,
      encoding: 'utf8'
    })
      .split('\0')
      .filter((path) => path && existsSync(resolve(projectRoot, path)))
  )
  const contents = new Map<string, string>()
  const read = (path: string): string | undefined => {
    if (Object.hasOwn(overrides, path)) return overrides[path]
    if (!files.has(path)) return undefined
    if (!contents.has(path)) contents.set(path, readFileSync(resolve(projectRoot, path), 'utf8'))
    return contents.get(path)
  }
  const manifest = loadModuleImpactManifest(resolve(projectRoot, 'scripts/ci/module-impact.json'))
  const owners = new Map<string, string>(
    Object.entries(manifest.modules).flatMap(([id, module]) =>
      module.ownerPaths.map((path: string) => [path, id] as [string, string])
    )
  )
  const production = new Set(
    [...files].filter(
      (path) =>
        /^src\/(?:main|renderer|shared)\/.*\.[cm]?[jt]sx?$/.test(path) &&
        !/\.(test|spec)\.|\/(?:__tests__|__fixtures__|test-fixtures|test-support|test-utils)\/|(?:^|[/._-])(?:test|spec)[-_.](?:support|fixtures|helpers)/.test(
          path
        ) &&
        owners.get(path) !== 'renderer_test_utils'
    )
  )
  const runtimeEdges = Object.entries(JSON.parse(read('scripts/ci/module-runtime-consumers.json')!))
  const structuralReader = createConsumerDependencyReader({ files, read }, runtimeEdges)
  const runtimeReader = createConsumerDependencyReader({ files, read }, runtimeEdges, {
    runtimeOnly: true
  })
  const structural: Graph = new Map()
  const boundaryEdges: Graph = new Map()
  const runtimeModules: Graph = new Map()
  for (const path of production) {
    boundaryEdges.set(path, structuralReader.dependencies(path).paths)
    structural.set(
      path,
      new Set(
        [...structuralReader.dependencies(path).paths].filter((target) => production.has(target))
      )
    )
    const owner = owners.get(path)
    if (!owner) throw new Error(`Missing host owner: ${path}`)
    const targets = runtimeModules.get(owner) ?? new Set<string>()
    for (const target of runtimeReader.dependencies(path).paths) {
      const targetOwner = owners.get(target)
      if (production.has(target) && targetOwner && targetOwner !== owner) targets.add(targetOwner)
    }
    runtimeModules.set(owner, targets)
  }
  const consumerModules: Graph = new Map(
    Object.entries(manifest.modules).map(([id, module]) => [
      id,
      new Set<string>(module.consumerModules)
    ])
  )
  return {
    structural,
    runtimeModules,
    consumerModules,
    violations: [
      ...boundaryViolations(boundaryEdges, manifest.modules),
      ...[...boundaryEdges].flatMap(([source, targets]) => {
        const upperOwner = lowerLayerBoundaries.get(owners.get(source) ?? '')
        return upperOwner
          ? [...targets]
              .filter((target) => owners.get(target) === upperOwner)
              .map(
                (target) => `${source} -> ${target}: lower layer imports application implementation`
              )
          : []
      }),
      ...[...production]
        .filter((path) => dependencyLayer(path) === 'foundation')
        .flatMap((path) => {
          const inspect = createConsumerDependencyReader({ files, read }, runtimeEdges, {
            staticOnly: true
          })
          return inspect(path, new Set()).complete
            ? []
            : [`${path}: pure foundation has opaque dependencies`]
        })
    ]
  }
}

describe('host dependency layers', () => {
  it('checks resolved package and preload targets outside the host cycle graph', () => {
    const graphs = hostGraphs({
      'src/shared/in-flight-promise.ts': "import '@aipoch/diagnostics'",
      'src/shared/bootstrap.ts': "import '../preload/index'",
      'src/main/notebook/session-aggregate.ts':
        "import type { TransientViewImage } from './host-view-image-service'",
      'src/main/settings/repository.ts':
        "import type { LocalShellRuntimeMutation } from './local-shell-runtime-mutation'",
      'src/main/desktop-interaction.ts':
        "export type Environment = import('./cli-install/launcher').CliLauncherEnv"
    })
    expect(graphs.violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('src/shared/in-flight-promise.ts -> packages/diagnostics/'),
        expect.stringContaining('src/shared/bootstrap.ts -> src/preload/index.ts'),
        expect.stringContaining(
          'src/main/notebook/session-aggregate.ts -> src/main/notebook/host-view-image-service.ts'
        ),
        expect.stringContaining(
          'src/main/settings/repository.ts -> src/main/settings/local-shell-runtime-mutation.ts'
        ),
        expect.stringContaining(
          'src/main/desktop-interaction.ts -> src/main/cli-install/launcher.ts'
        )
      ])
    )
  }, 180_000)

  it('detects indirect cycles as well as reciprocal imports', () => {
    expect(
      cycles(
        new Map([
          ['contract', new Set(['service'])],
          ['service', new Set(['composition'])],
          ['composition', new Set(['contract'])]
        ])
      )
    ).toEqual(['contract -> service -> composition -> contract'])
    expect(
      cycles(
        new Map([
          ['composition', new Set(['service'])],
          ['service', new Set(['contract'])],
          ['contract', new Set()]
        ])
      )
    ).toEqual([])
  })

  // Whole-repository parsing needs headroom under coverage on shared CI runners.
  it('keeps type contracts, runtime module dependencies and test routing acyclic', () => {
    const graphs = hostGraphs()
    expect(
      graphs.violations,
      'foundation, contract, composition and public-interface boundaries'
    ).toEqual([])
    expect(
      cycles(graphs.structural),
      'production imports including types and registered dynamic edges'
    ).toEqual([])
    expect(cycles(graphs.runtimeModules), 'runtime dependencies between module owners').toEqual([])
    expect(cycles(graphs.consumerModules), 'consumer test routing').toEqual([])
  }, 180_000)
})
