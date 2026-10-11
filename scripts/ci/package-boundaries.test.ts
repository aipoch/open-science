import { readFileSync, readdirSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { packageTestRegistrationViolations } from './package-test-policy.mjs'
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
  const byName = new Map(manifests.map((entry) => [entry.manifest.name, entry]))
  const packageDirectory = resolve('packages') + sep
  const packageRoots = manifests.map((entry) => resolve(entry.root) + sep)
  for (const file of files('src').filter((path) => /\.[cm]?[jt]sx?$/.test(path))) {
    for (const { fileName: specifier } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
      .importedFiles) {
      if (specifier.startsWith('.')) {
        const target = resolve(file, '..', specifier)
        if (
          target.startsWith(packageDirectory) &&
          packageRoots.some((root) => target.startsWith(root))
        )
          violations.push(`${file} -> ${specifier}: repository-relative package import`)
        continue
      }
      const name = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0]
      const entry = byName.get(name)
      if (!entry) continue
      const key = specifier === name ? '.' : '.' + specifier.slice(name.length)
      if (!Object.hasOwn(entry.manifest.exports, key))
        violations.push(`${file} -> ${specifier}: private package import`)
    }
  }
  expect(violations).toEqual([])
  // Match the consumer-coverage guard's allowance for a repository-wide scan under CI load.
}, 60_000)

it('module evidence never pulls in upstream or unrelated package tests', async () => {
  const { loadModuleImpactManifest } = await import('./load-module-impact.mjs')
  expect(packageTestRegistrationViolations(loadModuleImpactManifest(), registry)).toEqual([])
})

// Cover packages still outside the independent-suite registry as well. Tests and
// fixtures must not import host code, even when the test compiles a source string.
it('all package tests and fixtures keep relative dependencies inside their package', () => {
  const violations: string[] = []
  for (const file of files('packages').filter(
    (path) =>
      /\.[cm]?[jt]sx?$/.test(path) &&
      (/\.(test|spec)\./.test(path) || /\/(test|tests|test-fixtures)\//.test(path))
  )) {
    const root = resolve(file.split('/').slice(0, 2).join('/'))
    const text = readFileSync(file, 'utf8')
    const inspect = (source: string): void => {
      for (const { fileName: specifier } of ts.preProcessFile(source, true, true).importedFiles) {
        if (!specifier.startsWith('.')) continue
        const target = relative(root, resolve(file, '..', specifier))
          .split(sep)
          .join('/')
        if (target === '..' || target.startsWith('../')) violations.push(`${file} -> ${specifier}`)
      }
    }
    inspect(text)
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) inspect(node.text)
      if (
        ts.isCallExpression(node) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        ['vi.mock', 'vi.doMock', 'vi.importActual', 'jest.mock'].includes(
          node.expression.getText(source)
        )
      ) {
        inspect(`import ${JSON.stringify(node.arguments[0].text)}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  expect(violations).toEqual([])
}, 60_000)

it('module evidence follows independent package dependency direction', async () => {
  const { loadModuleImpactManifest } = await import('./load-module-impact.mjs')
  const { modules } = loadModuleImpactManifest()
  const violations: string[] = []
  for (const [id, module] of Object.entries(modules) as [
    string,
    { ownerPaths: string[]; testFiles: Record<string, string[]>; consumerModules: string[] }
  ][]) {
    const { excluded } = createPackageTestPlan(module.ownerPaths, registry)
    for (const test of Object.values(module.testFiles).flat())
      if (excluded.some((root) => test.startsWith(root + '/'))) violations.push(`${id} -> ${test}`)
    for (const consumer of module.consumerModules)
      for (const path of modules[consumer].ownerPaths)
        if (excluded.some((root) => path.startsWith(root + '/')))
          violations.push(`${id} -> module ${consumer} -> ${path}`)
  }
  expect(violations).toEqual([])
})

it('PDF workflow sources contain no application source taxonomy or database adapter', () => {
  const sources = files('packages/pdf-translation/src').filter((path) => path.endsWith('.ts'))
  for (const file of sources) {
    const source = readFileSync(file, 'utf8')
    expect(source, file).not.toMatch(
      /@prisma\/|\$queryRaw|\$executeRaw|attachmentVersionId|literature-attachment-version|upload-version|artifact-version|\bprojectId\b|\bsessionId\b/
    )
  }
})

it('local module and affected plans obey the same downstream package direction as Ubuntu', async () => {
  const { createModuleTestPlan, createAffectedTestPlan } = await import('./module-test-impact.mjs')
  for (const id of [
    'main_pdf_translation',
    'workspace_previews',
    'main_literature',
    'page_literature'
  ])
    expect(
      createModuleTestPlan(id).testFiles.filter((path) => path.startsWith('packages/'))
    ).toEqual([])
  for (const path of [
    'src/main/literature/pdf-translation/index.ts',
    'src/renderer/src/pages/workspace/previews/renderers/PdfPreview.tsx',
    'src/main/literature/command-owner.ts',
    'src/main/literature/journal-attributes.ts'
  ]) {
    const plan = createAffectedTestPlan([{ path, status: 'modified' }], {
      status: 'unavailable',
      testFiles: ['packages/pdf-translation/test/checkpoints.test.ts']
    })
    expect(plan.mode).toBe('selective')
    expect(plan.testFiles.filter((path) => path.startsWith('packages/'))).toEqual([])
    expect(plan.testFiles.some((path) => path.startsWith('src/'))).toBe(true)
  }
  const plan = createModuleTestPlan('package_pdf_translation')
  expect(plan.testFiles.some((path) => path.startsWith('packages/pdf-translation/'))).toBe(true)
  expect(plan.testFiles.some((path) => path.startsWith('packages/pdf-structure/'))).toBe(false)
})

it('host-only selective plans never include package-owned unit suites', async () => {
  const { loadModuleImpactManifest } = await import('./load-module-impact.mjs')
  const { createAffectedTestPlan, createModuleTestPlan } = await import('./module-test-impact.mjs')
  const manifest = loadModuleImpactManifest()
  let checked = 0
  for (const [id, module] of Object.entries(manifest.modules) as [
    string,
    { ownerPaths: string[] }
  ][]) {
    if (module.ownerPaths.some((path) => path.startsWith('packages/'))) continue
    const source = module.ownerPaths.find(
      (path) =>
        path.startsWith('src/') && /\.[cm]?tsx?$/.test(path) && !/\.(test|spec)\./.test(path)
    )
    if (!source) continue
    for (const plan of [
      createModuleTestPlan(id, manifest),
      createAffectedTestPlan(
        [{ path: source, status: 'modified' }],
        { status: 'not-requested', testFiles: [] },
        manifest
      )
    ]) {
      if (plan.mode !== 'selective') continue
      checked += 1
      expect(
        plan.testFiles.filter((path: string) => path.startsWith('packages/')),
        `${id}: ${source}`
      ).toEqual([])
    }
  }
  expect(checked).toBeGreaterThan(0)
})

it('host source edits never select unchanged upstream PDF package implementation tests', async () => {
  const { loadModuleImpactManifest } = await import('./load-module-impact.mjs')
  const { createAffectedTestPlan } = await import('./module-test-impact.mjs')
  const { modules } = loadModuleImpactManifest()
  const violations: string[] = []
  for (const [id, module] of Object.entries(modules) as [string, { ownerPaths: string[] }][]) {
    if (module.ownerPaths.some((path) => path.startsWith('packages/pdf-'))) continue
    const source = module.ownerPaths.find(
      (path) => path.startsWith('src/') && !path.includes('.test.')
    )
    if (!source) continue
    // Integrity retains historical registration evidence. Package boundaries apply to the
    // executable plan, including stale graph suggestions, rather than to raw evidence records.
    const plan = createAffectedTestPlan([{ path: source, status: 'modified' }], {
      status: 'not-used',
      testFiles: []
    })
    for (const test of plan.testFiles)
      if (/^packages\/pdf-(translation|structure)\//.test(test)) violations.push(`${id} -> ${test}`)
  }
  expect(violations).toEqual([])
})

it('Compute host edits never register or select upstream Compute units', async () => {
  const { loadModuleImpactManifest } = await import('./load-module-impact.mjs')
  const { createAffectedTestPlan, createModuleTestPlan } = await import('./module-test-impact.mjs')
  const { modules } = loadModuleImpactManifest()
  for (const [id, module] of Object.entries(modules) as [
    string,
    { ownerPaths: string[]; testFiles: Record<string, string[]> }
  ][]) {
    if (module.ownerPaths.some((path) => path.startsWith('packages/'))) continue
    expect(
      Object.values(module.testFiles)
        .flat()
        .filter((path) => path.startsWith('packages/compute/')),
      id
    ).toEqual([])
  }
  expect(
    createModuleTestPlan('compute_service').testFiles.filter((path) =>
      path.startsWith('packages/compute/')
    )
  ).toEqual([])
  const graph = { status: 'not-used', testFiles: [] }
  const host = createAffectedTestPlan(
    [{ path: 'src/main/compute/compute-job-workflow-owner.ts', status: 'modified' }],
    graph
  )
  expect(host.mode).toBe('selective')
  expect(host.testFiles).toContain('src/main/compute/compute-job-workflow-owner.test.ts')
  expect(host.testFiles.filter((path) => path.startsWith('packages/'))).toEqual([])
  for (const path of [
    'packages/compute/src/job-poller.ts',
    'packages/compute/src/node.ts',
    'packages/compute/src/model.ts'
  ]) {
    const plan = createAffectedTestPlan([{ path, status: 'modified' }], graph)
    expect(plan.mode, path).toBe('selective')
    expect(plan.testFiles, path).toEqual(
      expect.arrayContaining([
        'packages/compute/src/job-poller.test.ts',
        'src/main/compute/job-poller.test.ts',
        'src/main/compute/cancellation-runtime.integration.test.ts',
        'src/main/compute/job-deletion-runtime-isolation.test.ts'
      ])
    )
    // The CLI package is a real downstream host contract, not an unrelated upstream unit suite.
    expect(
      plan.testFiles.filter(
        (file) => file.startsWith('packages/') && !file.startsWith('packages/compute/')
      ),
      path
    ).toEqual(
      path.endsWith('/model.ts')
        ? ['packages/open-science/cli.test.ts', 'packages/open-science/client.test.ts']
        : []
    )
  }
})

it('every module plan excludes unrelated upstream package tests', async () => {
  const { loadModuleImpactManifest } = await import('./load-module-impact.mjs')
  const { createModuleTestPlan } = await import('./module-test-impact.mjs')
  const manifest = loadModuleImpactManifest()
  const violations: string[] = []
  // Validate executed coverage while the trusted retirement policy permits cleanup of
  // historical redundant registrations. Full-validation owners retain their fallback.
  for (const [id, module] of Object.entries(manifest.modules) as [
    string,
    { ownerPaths: string[] }
  ][]) {
    const plan = createModuleTestPlan(id, manifest)
    if (plan.mode === 'full') continue
    const { excluded } = createPackageTestPlan(module.ownerPaths, registry)
    for (const test of plan.testFiles)
      if (excluded.some((root) => test.startsWith(root + '/'))) violations.push(`${id} -> ${test}`)
  }
  expect(violations).toEqual([])
})
