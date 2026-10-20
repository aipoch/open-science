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
  for (const file of [
    ...files(join(root, 'src')),
    ...files(join(root, 'test')),
    ...files(join(root, 'scripts'))
  ]) {
    if (!/\.[cm]?[jt]s$/.test(file)) continue
    for (const { fileName: spec } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
      .importedFiles) {
      if (spec.startsWith('.')) {
        const target = relative(root, resolve(dirname(file), spec))
        expect(target.startsWith('..'), `${file}: ${spec}`).toBe(false)
      } else if (spec === manifest.name || spec.startsWith(manifest.name + '/')) {
        expect(
          Object.hasOwn(
            manifest.exports,
            spec === manifest.name ? '.' : '.' + spec.slice(manifest.name.length)
          )
        ).toBe(true)
      } else if (!spec.startsWith('node:') && !builtinModules.includes(spec)) {
        const name = spec.startsWith('@')
          ? spec.split('/').slice(0, 2).join('/')
          : spec.split('/')[0]
        const dependencies =
          /\.test\.ts$/.test(file) || file.includes(`${join(root, 'scripts')}/`)
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

it('keeps host session, approval and usage-display contracts out of package implementation', () => {
  for (const file of files(join(root, 'src')).filter(
    (path) => path.endsWith('.ts') && !path.endsWith('.test.ts')
  )) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
    const forbidden = new Set([
      'TrustedCallingSession',
      'approveDelete',
      'callerRole',
      'mainEnabled',
      'specialists',
      'HostSkillsService'
    ])
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node))
        expect(forbidden.has(node.text), `${file}: host contract ${node.text}`).toBe(false)
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  const runtime = readFileSync(join(root, 'src/runtime-document.ts'), 'utf8')
  expect(runtime).not.toContain("'.claude'")
  expect(runtime).not.toContain("type: 'string'")
  for (const file of ['agent-home-skill-catalog.ts', 'agent-home-skill-owner.ts']) {
    expect(readFileSync(join(root, 'src', file), 'utf8')).not.toMatch(
      /~\/\.(?:agents|claude|codex)/
    )
  }
})

it('does not embed a marketplace protocol, source, queue or host market contract', () => {
  for (const file of [...files(join(root, 'src')), ...files(join(root, 'scripts'))]) {
    if (!/\.[cm]?[jt]s$/.test(file)) continue
    expect(readFileSync(file, 'utf8'), relative(root, file)).not.toMatch(
      /marketplace|openscience-skills|statics\.aipoch\.com/i
    )
  }
})
