import { readFileSync, readdirSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

const featureRoot = resolve(__dirname)
const rendererRoot = resolve(featureRoot, '../..')
const publicEntries = new Set([
  'public/host',
  'public/page',
  'public/queries',
  'public/events',
  'public/components'
])
const imports = (file: string): string[] =>
  ts
    .preProcessFile(readFileSync(file, 'utf8'), true, true)
    .importedFiles.map(({ fileName }) => fileName)

it('keeps the opt-in test renderer free of production adapters and eager feature stores', () => {
  const helper = resolve(featureRoot, '../../../../../test/renderer/literature.ts')
  const allowed = new Set([
    helper,
    resolve(featureRoot, 'public/host.ts'),
    resolve(featureRoot, 'renderer-provider.tsx'),
    resolve(featureRoot, 'renderer-host.ts')
  ])
  const visited = new Set<string>()
  const pending = [helper]
  while (pending.length) {
    const file = pending.pop()!
    if (visited.has(file)) continue
    visited.add(file)
    expect(allowed.has(file), `Unexpected runtime dependency: ${file}`).toBe(true)
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest)
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue
      if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause
        if (clause?.isTypeOnly) continue
        if (
          !clause?.name &&
          clause?.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly)
        )
          continue
      }
      if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      const specifier = statement.moduleSpecifier.text
      const module = ts.resolveModuleName(
        specifier,
        file,
        {
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          paths: {
            '@/*': [resolve(rendererRoot, '*')],
            '@renderer/*': [resolve(rendererRoot, '*')]
          }
        },
        ts.sys
      ).resolvedModule
      if (/^(\.|@\/|@renderer\/)/.test(specifier))
        expect(module, `Unresolved local dependency: ${specifier}`).toBeDefined()
      if (module && !module.isExternalLibraryImport) pending.push(resolve(module.resolvedFileName))
    }
  }
})

it('keeps renderer consumers on explicit Literature public entries', () => {
  const violations: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name)
      if (file === featureRoot) continue
      if (entry.isDirectory()) visit(file)
      else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
        for (const specifier of imports(file)) {
          const alias = ['@/', '@renderer/'].find((prefix) => specifier.startsWith(prefix))
          const target = alias
            ? resolve(rendererRoot, specifier.slice(alias.length))
            : specifier.startsWith('.')
              ? resolve(dirname(file), specifier)
              : undefined
          if (!target) continue
          const featurePath = relative(featureRoot, target)
            .replaceAll('\\', '/')
            .replace(/\.tsx?$/, '')
          if (!featurePath.startsWith('../') && !publicEntries.has(featurePath))
            violations.push(`${relative(rendererRoot, file)} -> ${specifier}`)
        }
      }
    }
  }
  visit(rendererRoot)
  expect(violations).toEqual([])
})

it('keeps the Library page out of eager integration entrypoints', () => {
  const visited = new Set<string>()
  const pending = [...publicEntries]
    .filter((entry) => entry !== 'public/page')
    .map((entry) => resolve(featureRoot, `${entry}.ts`))
  while (pending.length) {
    const current = pending.pop()!
    if (visited.has(current)) continue
    visited.add(current)
    expect(current).not.toBe(resolve(featureRoot, 'LiteratureLibraryPage.tsx'))
    for (const specifier of imports(current)) {
      const module = ts.resolveModuleName(
        specifier,
        current,
        {
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          paths: {
            '@/*': [resolve(rendererRoot, '*')],
            '@renderer/*': [resolve(rendererRoot, '*')]
          }
        },
        ts.sys
      ).resolvedModule
      if (
        module &&
        !module.isExternalLibraryImport &&
        resolve(module.resolvedFileName).startsWith(`${featureRoot}${sep}`)
      )
        pending.push(module.resolvedFileName)
    }
  }
})

it('keeps transport, store types and sibling implementations behind the feature-owned host port', () => {
  const violations: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        visit(file)
        continue
      }
      if (!/\.tsx?$/.test(entry.name) || /\.(test|spec)\.tsx?$/.test(entry.name)) continue
      const source = readFileSync(file, 'utf8')
      if (/\bwindow\s*(?:\?\.)?\.\s*api\b/.test(source))
        violations.push(`${entry.name}: global transport`)
      for (const target of imports(file)) {
        if (
          /\/stores\//.test(target) ||
          /\/(workspace|home)\//.test(target) ||
          /useProjectFormDialog$/.test(target)
        )
          violations.push(`${relative(featureRoot, file)} -> ${target}`)
      }
    }
  }
  visit(featureRoot)
  expect(violations).toEqual([])
})
