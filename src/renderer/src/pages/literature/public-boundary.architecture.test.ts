import { readFileSync, readdirSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

const featureRoot = __dirname
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
        module.resolvedFileName.startsWith(`${featureRoot}/`)
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
