import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const sourceRoot = resolve('src')
const sharedRoot = join(sourceRoot, 'shared')
const facade = join(sharedRoot, 'session-persistence.ts')
const implementationRoot = join(sharedRoot, 'session-persistence')
const implementationFiles = readdirSync(implementationRoot)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => join(implementationRoot, name))

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)

const imports = (file: string): ts.ImportDeclaration[] =>
  parse(file).statements.filter(ts.isImportDeclaration)

const target = (file: string, declaration: ts.ImportDeclaration): string =>
  resolve(dirname(file), (declaration.moduleSpecifier as ts.StringLiteral).text) + '.ts'

const hasRuntimeBinding = (declaration: ts.ImportDeclaration): boolean => {
  const clause = declaration.importClause
  if (!clause) return true
  if (clause.isTypeOnly) return false
  if (clause.name || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings))
    return true
  return clause.namedBindings.elements.some((element) => !element.isTypeOnly)
}

describe('shared session persistence boundaries', () => {
  it('keeps the public facade declarative and internal exports explicit', () => {
    for (const statement of parse(facade).statements) {
      expect(ts.isExportDeclaration(statement)).toBe(true)
      if (
        ts.isExportDeclaration(statement) &&
        (statement.moduleSpecifier as ts.StringLiteral).text.startsWith('./session-persistence/')
      ) {
        expect(statement.exportClause).toBeDefined()
      }
    }
  })

  it('keeps implementation dependencies directed without runtime cycles or facade back-edges', () => {
    const edges = new Map<string, string[]>()
    for (const file of implementationFiles) {
      const dependencies = imports(file)
      expect(dependencies.map((declaration) => target(file, declaration))).not.toContain(facade)
      edges.set(
        file,
        dependencies
          .filter(hasRuntimeBinding)
          .map((declaration) => target(file, declaration))
          .filter((dependency) => implementationFiles.includes(dependency))
      )
    }
    const visit = (file: string, ancestors: string[]): void => {
      expect(ancestors, relative(sharedRoot, file)).not.toContain(file)
      for (const dependency of edges.get(file) ?? []) visit(dependency, [...ancestors, file])
    }
    for (const file of implementationFiles) visit(file, [])
  })

  it('keeps external consumers on the facade, except type-only graph and envelope contracts', () => {
    const modelConsumers = new Set([
      join(sharedRoot, 'conversation-graph.ts'),
      join(sharedRoot, 'session-conversation-graph-materialization.ts'),
      join(sharedRoot, 'session-persistence-envelope.ts')
    ])
    const violations: string[] = []
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name)
        if (file === implementationRoot || file === facade || file.endsWith('.test.ts')) continue
        if (entry.isDirectory()) {
          walk(file)
          continue
        }
        if (!/\.tsx?$/.test(file) || !readFileSync(file, 'utf8').includes('session-persistence/')) {
          continue
        }
        for (const declaration of imports(file)) {
          const dependency = target(file, declaration)
          if (!implementationFiles.includes(dependency)) continue
          if (
            !modelConsumers.has(file) ||
            hasRuntimeBinding(declaration) ||
            !['message.ts', 'session.ts'].includes(relative(implementationRoot, dependency))
          ) {
            violations.push(relative(sourceRoot, file))
          }
        }
      }
    }
    walk(sourceRoot)
    expect(violations).toEqual([])
  })
})
