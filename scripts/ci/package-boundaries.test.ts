import { builtinModules } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, relative, sep } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { localPackageSourcePaths } from './local-package-exports.mjs'
import { createPackageTestPlan, validatePackageTestRegistry } from './package-test-impact.mjs'

const registry = validatePackageTestRegistry(
  JSON.parse(readFileSync('scripts/ci/package-test-boundaries.json', 'utf8'))
)
const manifests = registry.packages.map((entry: { root: string; dependencies: string[] }) => ({
  ...entry,
  manifest: JSON.parse(readFileSync(`${entry.root}/package.json`, 'utf8'))
}))
function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', '.git'].includes(entry.name)) return []
    const path = `${root}/${entry.name}`
    return entry.isDirectory() ? files(path) : [path]
  })
}

it('resolves every exported implementation in this checkout without installed source aliases', () => {
  expect(Object.keys(localPackageSourcePaths()).length).toBeGreaterThan(manifests.length)
})

for (const entry of manifests) {
  it(`${entry.manifest.name} declares every direct import and contains its relative imports`, () => {
    const violations: string[] = []
    const production = {
      ...entry.manifest.dependencies,
      ...entry.manifest.peerDependencies,
      ...entry.manifest.optionalDependencies
    }
    const development = { ...production, ...entry.manifest.devDependencies }
    for (const file of files(entry.root).filter((path) => /\.[cm]?[jt]sx?$/.test(path))) {
      const runtime = /\/(src|resources)\//.test(file) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)
      const declared = runtime ? production : development
      const text = readFileSync(file, 'utf8')
      const imports = ts.preProcessFile(text, true, true).importedFiles
      const rejectedImports = new Set<string>()
      if (!runtime && text.includes('ERR_PACKAGE_PATH_NOT_EXPORTED')) {
        const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
        const visit = (node: ts.Node): void => {
          if (ts.isCallExpression(node) && node.expression.getText(source) === 'assert.rejects') {
            const [attempt, expected] = node.arguments
            if (
              attempt &&
              ts.isCallExpression(attempt) &&
              attempt.expression.kind === ts.SyntaxKind.ImportKeyword &&
              attempt.arguments[0] &&
              ts.isStringLiteral(attempt.arguments[0]) &&
              expected &&
              expected.getText(source).includes("code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'")
            )
              rejectedImports.add(attempt.arguments[0].text)
          }
          ts.forEachChild(node, visit)
        }
        visit(source)
      }
      for (const { fileName: specifier } of imports) {
        if (specifier.startsWith('node:') || builtinModules.includes(specifier)) continue
        if (specifier.startsWith('.')) {
          const target = resolve(file, '..', specifier)
          const within = relative(resolve(entry.root), target).split(sep).join('/')
          if (within.startsWith('../') || within === '..')
            violations.push(`${file} -> ${specifier}: escapes package`)
          continue
        }
        const name = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0]
        if (!Object.hasOwn(declared, name) && name !== entry.manifest.name)
          violations.push(
            `${file} -> ${specifier}: undeclared ${runtime ? 'production' : 'development'} dependency`
          )
        const sibling = manifests.find(
          (candidate: typeof entry) => candidate.manifest.name === name
        )
        if (sibling) {
          const key = specifier === name ? '.' : `.${specifier.slice(name.length)}`
          if (!Object.hasOwn(sibling.manifest.exports, key) && !rejectedImports.has(specifier))
            violations.push(`${file} -> ${specifier}: private subpath`)
          if (sibling.root !== entry.root && !entry.dependencies.includes(sibling.root))
            violations.push(`${file} -> ${specifier}: missing CI dependency`)
        }
      }
    }
    expect(violations).toEqual([])
  })
  it(`${entry.manifest.name} selects its own tests and downstream consumers, never unrelated upstream tests`, () => {
    const plan = createPackageTestPlan([`${entry.root}/src/change.ts`], registry)
    expect(plan.selected).toContain(entry.root)
    for (const upstream of entry.dependencies) expect(plan.excluded).toContain(upstream)
  })
}

it('a Literature host-only change runs zero unchanged package suites', () => {
  const plan = createPackageTestPlan(
    ['src/renderer/src/pages/literature/LiteratureLibraryPage.tsx'],
    registry
  )
  expect(plan.selected).toEqual([])
  expect(plan.excluded).toHaveLength(manifests.length)
})

it('host consumers use only public package names and exported subpaths', () => {
  const violations: string[] = []
  for (const file of files('src').filter((path) => /\.[cm]?[jt]sx?$/.test(path))) {
    for (const { fileName: specifier } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
      .importedFiles) {
      for (const entry of manifests) {
        const name = entry.manifest.name
        if (specifier === name || specifier.startsWith(name + '/')) {
          const key = specifier === name ? '.' : '.' + specifier.slice(name.length)
          if (!Object.hasOwn(entry.manifest.exports, key))
            violations.push(`${file} -> ${specifier}: private package import`)
        } else if (specifier.startsWith('.')) {
          const target = resolve(file, '..', specifier)
          if (target.startsWith(resolve(entry.root) + sep))
            violations.push(`${file} -> ${specifier}: repository-relative package import`)
        }
      }
    }
  }
  expect(violations).toEqual([])
})
