import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'

import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isStringLiteralLike,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type Node
} from 'typescript'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(__dirname, '../..')
const mainRoot = resolve(projectRoot, 'src/main')
const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts'] as const

const productionSources = (): string[] => {
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (
        sourceExtensions.includes(extname(path) as (typeof sourceExtensions)[number]) &&
        !/\.(?:test|spec)(?:-support|-harness)?\.[cm]?tsx?$/.test(entry.name) &&
        !entry.name.endsWith('.d.ts')
      ) {
        files.push(path)
      }
    }
  }
  visit(mainRoot)
  return files.sort()
}

const runtimeImportSpecifiers = (path: string): string[] => {
  const specifiers: string[] = []
  const sourceFile = createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ScriptTarget.Latest,
    true,
    extname(path) === '.tsx' ? ScriptKind.TSX : ScriptKind.TS
  )
  const visit = (node: Node): void => {
    if (isImportDeclaration(node) && isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause
      const hasRuntimeBinding =
        clause === undefined ||
        (!clause.isTypeOnly &&
          (clause.name !== undefined ||
            clause.namedBindings === undefined ||
            !('elements' in clause.namedBindings) ||
            clause.namedBindings.elements.some((element) => !element.isTypeOnly)))
      if (hasRuntimeBinding) specifiers.push(node.moduleSpecifier.text)
    } else if (
      isExportDeclaration(node) &&
      node.moduleSpecifier &&
      isStringLiteralLike(node.moduleSpecifier) &&
      !node.isTypeOnly &&
      (!node.exportClause ||
        !('elements' in node.exportClause) ||
        node.exportClause.elements.some((element) => !element.isTypeOnly))
    ) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (isCallExpression(node)) {
      const [argument] = node.arguments
      const isRequire = isIdentifier(node.expression) && node.expression.text === 'require'
      const isDynamicImport = node.expression.kind === SyntaxKind.ImportKeyword
      if ((isRequire || isDynamicImport) && argument && isStringLiteralLike(argument)) {
        specifiers.push(argument.text)
      }
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)
  return specifiers
}

const resolveRelativeImport = (source: string, specifier: string): string | undefined => {
  if (!specifier.startsWith('.')) return undefined
  const base = resolve(dirname(source), specifier.replace(/\.[cm]?js$/, ''))
  const candidates = [
    ...sourceExtensions.map((extension) => `${base}${extension}`),
    ...sourceExtensions.map((extension) => resolve(base, `index${extension}`))
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

const runtimeImportGraph = (): Map<string, readonly string[]> => {
  const sources = productionSources()
  const sourceSet = new Set(sources)
  return new Map(
    sources.map((source) => [
      source,
      [
        ...new Set(
          runtimeImportSpecifiers(source)
            .map((specifier) => resolveRelativeImport(source, specifier))
            .filter((target): target is string => target !== undefined && sourceSet.has(target))
        )
      ].sort()
    ])
  )
}

const canonicalCycle = (cycle: readonly string[]): string => {
  const nodes = cycle.slice(0, -1).map((path) => relative(projectRoot, path).replaceAll('\\', '/'))
  const rotations = nodes.map((_, index) => [...nodes.slice(index), ...nodes.slice(0, index)])
  const canonical = rotations.sort((left, right) => left.join().localeCompare(right.join()))[0]
  return [...canonical, canonical[0]].join(' -> ')
}

const runtimeImportCycles = (): string[] => {
  const graph = runtimeImportGraph()
  const visited = new Set<string>()
  const active = new Set<string>()
  const stack: string[] = []
  const cycles = new Set<string>()

  const visit = (source: string): void => {
    visited.add(source)
    active.add(source)
    stack.push(source)
    for (const target of graph.get(source) ?? []) {
      if (!visited.has(target)) visit(target)
      else if (active.has(target)) {
        cycles.add(canonicalCycle([...stack.slice(stack.indexOf(target)), target]))
      }
    }
    stack.pop()
    active.delete(source)
  }

  for (const source of graph.keys()) if (!visited.has(source)) visit(source)
  return [...cycles].sort()
}

describe('main-process runtime import architecture', () => {
  it('keeps production runtime dependencies acyclic', () => {
    expect(runtimeImportCycles()).toEqual([])
  })
})
