import { readFileSync, readdirSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]
  )

it('declares every dependency and keeps source and tests inside the package', () => {
  for (const file of [...files(join(root, 'src')), ...files(join(root, 'test'))]) {
    if (!file.endsWith('.ts')) continue
    for (const { fileName: spec } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
      .importedFiles) {
      if (spec.startsWith('.')) {
        const target = relative(root, resolve(dirname(file), spec))
        expect(target.startsWith('..'), `${file}: ${spec}`).toBe(false)
      } else if (!spec.startsWith('node:') && !builtinModules.includes(spec)) {
        const name = spec.startsWith('@')
          ? spec.split('/').slice(0, 2).join('/')
          : spec.split('/')[0]
        const dependencies = /\.test\.ts$/.test(file)
          ? { ...manifest.dependencies, ...manifest.devDependencies }
          : manifest.dependencies
        expect(dependencies, `${file}: ${spec}`).toHaveProperty(name)
      }
    }
  }
})

it('exposes only the documented package entry points', () => {
  expect(Object.keys(manifest.exports)).toEqual(['.', './document', './sources', './projection'])
  expect(manifest.files).toEqual(['dist', 'README.md', 'LICENSE'])
})

it('keeps public symbol changes explicit and forbids repository-local dependency shortcuts', () => {
  for (const entry of ['index', 'document', 'sources', 'projection']) {
    const path = join(root, 'src', `${entry}.ts`)
    const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    for (const statement of file.statements) {
      if (ts.isExportDeclaration(statement)) {
        expect(statement.exportClause, `${entry}: wildcard public export`).toBeDefined()
      }
    }
  }
  for (const dependency of Object.values({
    ...manifest.dependencies,
    ...manifest.devDependencies
  })) {
    expect(dependency).not.toMatch(/^(?:file:|link:|workspace:|\.|\/)/)
  }
})
