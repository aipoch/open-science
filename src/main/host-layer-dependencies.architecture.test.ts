import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
// @ts-expect-error The repository's JavaScript evidence reader has no declaration file.
import { createConsumerDependencyReader } from '../../scripts/ci/consumer-retirement.mjs'
import { loadModuleImpactManifest } from '../../scripts/ci/load-module-impact.mjs'

type Graph = Map<string, Set<string>>
const projectRoot = resolve(import.meta.dirname, '../..')

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

// The evidence reader deliberately over-approximates imports. Inline type-only
// bindings cannot create runtime edges, but must remain in the type graph.
function withoutInlineTypeDeclarations(path: string, text: string): string {
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const erased: Array<[number, number]> = []
  for (const node of ast.statements) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      if (
        clause &&
        !clause.isTypeOnly &&
        !clause.name &&
        clause.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((element) => element.isTypeOnly)
      )
        erased.push([node.getStart(ast), node.end])
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause) &&
      node.exportClause.elements.length > 0 &&
      node.exportClause.elements.every((element) => element.isTypeOnly)
    )
      erased.push([node.getStart(ast), node.end])
  }
  for (const [start, end] of erased.reverse()) text = text.slice(0, start) + text.slice(end)
  return text
}

function hostGraphs(): { structural: Graph; runtimeModules: Graph; consumerModules: Graph } {
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
  const runtimeReader = createConsumerDependencyReader(
    {
      files,
      read: (path: string) => {
        const text = read(path)
        return text !== undefined && production.has(path)
          ? withoutInlineTypeDeclarations(path, text)
          : text
      }
    },
    runtimeEdges,
    { runtimeOnly: true }
  )
  const structural: Graph = new Map()
  const runtimeModules: Graph = new Map()
  for (const path of production) {
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
  return { structural, runtimeModules, consumerModules }
}

describe('host dependency layers', () => {
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

  it('erases only declarations whose named bindings are all type-only', () => {
    const source = `import { type A } from './a';\nexport { type B } from './b';\nimport D, { type C } from './c';\nimport { type E, value } from './e';\nimport './effect';`
    expect(withoutInlineTypeDeclarations('sample.ts', source)).toBe(
      `\n\nimport D, { type C } from './c';\nimport { type E, value } from './e';\nimport './effect';`
    )
  })

  // Whole-repository parsing needs headroom under coverage on shared CI runners.
  it('keeps type contracts, runtime module dependencies and test routing acyclic', () => {
    const graphs = hostGraphs()
    expect(
      cycles(graphs.structural),
      'production imports including types and registered dynamic edges'
    ).toEqual([])
    expect(cycles(graphs.runtimeModules), 'runtime dependencies between module owners').toEqual([])
    expect(cycles(graphs.consumerModules), 'consumer test routing').toEqual([])
  }, 180_000)
})
