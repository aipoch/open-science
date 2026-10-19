import { readFileSync, readdirSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { packageTestRegistrationViolations } from './package-test-policy.mjs'
import { localPackageSourcePaths } from './local-package-exports.mjs'
import { loadModuleImpactManifest } from './load-module-impact.mjs'
import { requiredLanesForModulePlan } from './module-impact-shadow.mjs'
import {
  createPackageTestPlan,
  dedicatedPackageTestRoots,
  validatePackageTestRegistry
} from './package-test-impact.mjs'

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
    for (const [name, specifier] of Object.entries(production)) {
      // Consumer installs supply unpublished siblings as tarballs. A file: declaration can
      // accidentally pass that setup while making the original archive depend on repo layout.
      if (/^(?:file:|link:|workspace:|\.{0,2}\/|[A-Za-z]:[\\/])/.test(String(specifier)))
        violations.push(`${entry.manifest.name} -> ${name}: non-portable dependency ${specifier}`)
    }
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

const hostBoundaryManifest = loadModuleImpactManifest()
it('retains dedicated downstream host evidence while excluding independent upstream suites', async () => {
  const { createAffectedTestPlan, createModuleTestPlan } = await import('./module-test-impact.mjs')
  const manifest = structuredClone(hostBoundaryManifest)
  const source = 'src/shared/in-flight-promise.ts'
  const id = Object.keys(manifest.modules).find((id) =>
    manifest.modules[id].ownerPaths.includes(source)
  )!
  const module = manifest.modules[id]
  delete module.fullTestReason
  module.ownerPaths = [source, 'src/shared/in-flight-promise.test.ts']
  module.interfacePaths = [source]
  module.consumerModules = []
  const upstream = 'packages/diagnostics/src/index.test.ts'
  const dedicated = 'packages/notebook-network-sandbox/src/address-policy.test.ts'
  module.testFiles.consumer = [upstream, dedicated]
  const plan = createAffectedTestPlan(
    [{ path: source, status: 'modified' }],
    { status: 'not-requested', testFiles: [] },
    manifest
  )
  expect(plan.mode).toBe('selective')
  expect(plan.testFiles).toContain(dedicated)
  expect(plan.testFiles).not.toContain(upstream)
  // Explicit module runs keep their declared evidence; registration guards bound that evidence.
  expect(createModuleTestPlan(id, manifest).testFiles).toContain(dedicated)
})

const hostBoundaryCases = (
  Object.entries(hostBoundaryManifest.modules) as [string, { ownerPaths: string[] }][]
).flatMap(([id, module]) => {
  if (module.ownerPaths.some((path) => path.startsWith('packages/'))) return []
  const source = module.ownerPaths.find(
    (path) => path.startsWith('src/') && /\.[cm]?tsx?$/.test(path) && !/\.(test|spec)\./.test(path)
  )
  return source ? [{ id, source }] : []
})

it('includes host modules with selective test plans', async () => {
  const { createModuleTestPlan } = await import('./module-test-impact.mjs')
  expect(
    hostBoundaryCases.some(
      ({ id }) => createModuleTestPlan(id, hostBoundaryManifest).mode === 'selective'
    )
  ).toBe(true)
})

// Each module keeps its own timeout as the ownership manifest grows.
it.each(hostBoundaryCases)(
  'host-only selective plans exclude independent upstream package suites: $id',
  async ({ id, source }) => {
    const { createAffectedTestPlan, createModuleTestPlan } =
      await import('./module-test-impact.mjs')
    for (const plan of [
      createModuleTestPlan(id, hostBoundaryManifest),
      createAffectedTestPlan(
        [{ path: source, status: 'modified' }],
        { status: 'not-requested', testFiles: [] },
        hostBoundaryManifest
      )
    ]) {
      if (plan.mode !== 'selective') continue
      expect(
        plan.testFiles.filter(
          (path: string) =>
            path.startsWith('packages/') &&
            !dedicatedPackageTestRoots.some((root) => path.startsWith(root + '/'))
        ),
        `${id}: ${source}`
      ).toEqual([])
      // Portable CI excludes these integration tests; their declarations must retain the Linux job.
      if (
        plan.testFiles.some((path: string) =>
          [
            'packages/notebook-network-sandbox/src/filesystem-enforcement.integration.test.ts',
            'packages/notebook-network-sandbox/src/network-enforcement.integration.test.ts'
          ].includes(path)
        )
      )
        expect(requiredLanesForModulePlan(plan), `${id}: Linux isolation evidence`).toContain(
          'linux_runtime'
        )
    }
  }
)

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

it('selects durable file consumers downstream without testing unchanged prerequisites', async () => {
  const { createAffectedTestPlan, createModuleTestPlan, executeModuleTestPlan } =
    await import('./module-test-impact.mjs')
  const graph = { status: 'not-used', testFiles: [] }
  const cases = [
    [
      'packages/durable-files/src/index.ts',
      ['packages/durable-files', 'packages/skills', 'packages/specialists']
    ],
    ['packages/skills/src/specialist-package-adapter.ts', ['packages/skills']],
    ['packages/specialists/src/repository.ts', ['packages/specialists']],
    ['src/main/settings/document-store.ts', []],
    ['src/main/artifacts/repository.ts', []],
    [
      'packages/journal-catalog/src/index.ts',
      ['packages/journal-catalog', 'packages/literature-library']
    ],
    ['packages/literature-library/src/library.ts', ['packages/literature-library']],
    ['packages/literature-reading/src/reader.ts', ['packages/literature-reading']],
    ['src/main/literature/catalog.ts', []],
    ['src/main/literature/document-reader.ts', []],
    ['src/renderer/src/pages/literature/workflows/useLiteratureMetadata.ts', []]
  ] as const
  for (const [path, selected] of cases) {
    const packagePlan = createPackageTestPlan([path], registry)
    expect([...packagePlan.selected].sort(), path).toEqual([...selected].sort())
    const plan = createAffectedTestPlan([{ path, status: 'modified' }], graph)
    expect(plan.mode, path).toBe('selective')
    for (const entry of registry.packages) {
      const included = plan.testFiles.some((test: string) => test.startsWith(entry.root + '/'))
      expect(included, `${path} -> ${entry.root}`).toBe(selected.includes(entry.root as never))
    }
  }
  const durable = createAffectedTestPlan(
    [{ path: 'packages/durable-files/src/durable-json-file.ts', status: 'modified' }],
    graph
  )
  expect(durable.testFiles).toEqual(
    expect.arrayContaining([
      'packages/durable-files/src/durable-json-file.test.ts',
      'packages/skills/src/specialist-package-adapter.test.ts',
      'packages/specialists/src/repository.test.ts',
      'src/main/settings/document-store.test.ts',
      'src/main/session-persistence/repository.test.ts',
      'src/main/artifacts/artifact-save-crash.integration.test.ts'
    ])
  )
  for (const id of ['main_storage', 'skill_package', 'specialist_package']) {
    expect(
      createModuleTestPlan(id).testFiles.filter((test: string) =>
        test.startsWith('packages/durable-files/')
      ),
      id
    ).toEqual([])
  }
  // The executor forwards the exact filters to Vitest; upstream builds are a separate step.
  const invocations: string[][] = []
  executeModuleTestPlan(durable, {
    environment: { npm_execpath: '/fixture/npm-cli.js' },
    spawn: (_command: string, args: string[]) => {
      invocations.push(
        args.includes('test:module:arguments')
          ? JSON.parse(readFileSync(args.at(-1)!, 'utf8'))
          : args
      )
      return { status: 0 }
    }
  })
  expect(invocations.flat()).toContain('packages/durable-files/src/durable-json-file.test.ts')
})

it('routes download package changes downstream and host adapters without unchanged package units', async () => {
  const { createAffectedTestPlan, executeModuleTestPlan } = await import('./module-test-impact.mjs')
  const graph = { status: 'not-used', testFiles: [] }
  const packageRoot = 'packages/resilient-download'
  for (const path of [
    `${packageRoot}/src/resilient-download.ts`,
    `${packageRoot}/src/index.ts`,
    `${packageRoot}/src/types.ts`,
    `${packageRoot}/src/errors.ts`,
    `${packageRoot}/src/download-speed.ts`
  ]) {
    expect(createPackageTestPlan([path], registry).selected, path).toEqual([packageRoot])
    const plan = createAffectedTestPlan([{ path, status: 'modified' }], graph)
    expect(plan.mode).toBe('selective')
    expect(plan.testFiles).toEqual(
      expect.arrayContaining([
        `${packageRoot}/src/resilient-download.test.ts`,
        `${packageRoot}/src/transport.test.ts`,
        'src/main/update/downloader.test.ts',
        'src/main/local-models/download.test.ts',
        'src/main/local-models/owner.test.ts',
        'src/main/notebook/environment-download.contract.test.ts',
        'src/main/notebook/windows-runtime-download.contract.test.ts',
        'src/main/session-package/transfer.test.ts'
      ])
    )
    expect(plan.capabilityOverlays).toEqual(
      expect.arrayContaining(['windows_sensitive', 'notebook_network_sandbox'])
    )
    for (const entry of registry.packages)
      expect(
        plan.testFiles.some((file) => file.startsWith(entry.root + '/')),
        `${path} -> ${entry.root}`
      ).toBe(entry.root === packageRoot)
  }
  for (const [path, test] of [
    ['src/main/update/downloader.ts', 'src/main/update/downloader.test.ts'],
    ['src/main/local-models/download.ts', 'src/main/local-models/download.test.ts'],
    [
      'src/main/notebook/environment-download.ts',
      'src/main/notebook/environment-download.contract.test.ts'
    ],
    [
      'src/main/notebook/windows-runtime-manager.ts',
      'src/main/notebook/windows-runtime-download.contract.test.ts'
    ],
    ['src/main/session-package/transfer.ts', 'src/main/session-package/transfer.test.ts']
  ]) {
    const plan = createAffectedTestPlan([{ path, status: 'modified' }], graph)
    expect(plan.mode).toBe('selective')
    expect(plan.testFiles).toContain(test)
    for (const entry of registry.packages)
      expect(
        plan.testFiles.some((file) => file.startsWith(entry.root + '/')),
        `${path} -> ${entry.root}`
      ).toBe(false)
    const invocations: string[][] = []
    executeModuleTestPlan(plan, {
      environment: { npm_execpath: '/fixture/npm-cli.js' },
      spawn: (_command: string, args: string[]) => {
        invocations.push(
          args.includes('test:module:arguments')
            ? JSON.parse(readFileSync(args.at(-1)!, 'utf8'))
            : args
        )
        return { status: 0 }
      }
    })
    expect(invocations.flat()).toContain(test)
    expect(invocations.flat().some((value) => value.startsWith(packageRoot + '/'))).toBe(false)
  }
})

// Dedicated roots are safe exclusions only while no independent library consumes them.
it('independent packages do not depend on dedicated host packages', () => {
  const names = dedicatedPackageTestRoots.map(
    (root) => JSON.parse(readFileSync(`${root}/package.json`, 'utf8')).name
  )
  for (const { manifest } of manifests) {
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies
    }
    for (const name of names)
      expect(Object.hasOwn(dependencies, name), `${manifest.name} -> ${name}`).toBe(false)
  }
})

it('dedicated package edits retain module evidence and platform overlays', async () => {
  const { createAffectedTestPlan } = await import('./module-test-impact.mjs')
  const { loadModuleImpactManifest } = await import('./load-module-impact.mjs')
  const manifest = loadModuleImpactManifest()
  for (const root of dedicatedPackageTestRoots) {
    const owner = Object.values(manifest.modules).find((module) =>
      module.ownerPaths.some((path) => path.startsWith(root + '/'))
    )!
    const path = owner.ownerPaths.find(
      (path) =>
        path.startsWith(root + '/') &&
        /\.(?:[cm]?[jt]s|cc|rs|swift)$/.test(path) &&
        !/\.(test|spec)\./.test(path)
    )!
    const plan = createAffectedTestPlan(
      [{ path, status: 'modified' }],
      { status: 'not-requested', testFiles: [] },
      manifest
    )
    expect(plan.mode, root).toBe('selective')
    expect(plan.testFiles.length, root).toBeGreaterThan(0)
    expect(plan.testFiles, root).toEqual(expect.arrayContaining(owner.testFiles.owner))
    expect(
      plan.testFiles.filter((test) => manifests.some(({ root }) => test.startsWith(root + '/'))),
      root
    ).toEqual([])
    expect(plan.capabilityOverlays, root).toEqual(expect.arrayContaining(owner.capabilityOverlays))
  }
})

it('keeps provider units upstream of host adapters and selects real downstream contracts', async () => {
  const { createAffectedTestPlan } = await import('./module-test-impact.mjs')
  const { packageVerificationPlan } = await import('../package-verification-plan.mjs')
  const graph = { status: 'not-used', testFiles: [] }
  for (const path of [
    'packages/providers/src/providers/lookup.ts',
    'packages/providers/src/providers/create.ts',
    'packages/providers/src/providers/connection.ts',
    'packages/providers/src/protocols/messages/conversion.ts',
    'packages/providers/src/protocols/chat-completions/stream.ts',
    'packages/providers/src/protocols/messages/text.ts',
    'packages/providers/src/protocols/chat-completions/text.ts',
    'packages/providers/src/protocols/responses/text.ts',
    'packages/providers/src/providers/definitions.ts',
    'packages/providers/src/models/types.ts',
    'packages/providers/src/models/classification.ts',
    'packages/providers/src/discovery/models.ts',
    'packages/providers/src/protocols/responses/conversion.ts',
    'packages/providers/src/protocols/xai/responses.ts',
    'packages/providers/src/protocols/messages/tokens.ts',
    'packages/providers/src/responses/native.ts',
    'packages/providers/src/responses/request.ts',
    'packages/providers/src/responses/adapter.ts',
    'packages/providers/src/responses/replay.ts',
    'packages/providers/src/transport/sse.ts',
    'packages/providers/src/models/text-generation.ts',
    'packages/providers/src/providers.ts',
    'packages/providers/src/protocol.ts',
    'packages/providers/src/client.ts'
  ]) {
    expect(createPackageTestPlan([path], registry).selected).toEqual(['packages/providers'])
    const plan = createAffectedTestPlan([{ path, status: 'modified' }], graph)
    expect(plan.mode).toBe('selective')
    expect(plan.testFiles).toEqual(
      expect.arrayContaining([
        'packages/providers/src/providers/lookup.test.ts',
        'packages/providers/src/responses/conversion.test.ts',
        'packages/providers/src/models/text-generation.test.ts',
        'packages/providers/src/models/classification.test.ts',
        'packages/providers/src/providers/create.test.ts',
        'packages/providers/src/protocols/messages/conversion.test.ts',
        'packages/providers/src/protocols/chat-completions/stream.test.ts',
        'src/main/settings/classification-settings.test.ts',
        'src/main/literature/pdf-translation/local.test.ts',
        'src/main/settings/responses-to-chat-completions-bridge.test.ts',
        'src/main/settings/provider-transport-owner.test.ts',
        'src/main/literature/pdf-translation/api-target.test.ts',
        'src/main/agent-framework/codex.test.ts',
        'src/main/agent-framework/claude-code.test.ts',
        'src/main/agent-framework/opencode.test.ts'
      ])
    )
    expect(
      plan.testFiles.filter(
        (test) => test.startsWith('packages/') && !test.startsWith('packages/providers/')
      )
    ).toEqual([])
  }
  for (const [path, test] of [
    ['src/shared/pdf-text.ts', 'src/main/literature/pdf-translation/text-generation.test.ts'],
    ['src/shared/fuzzy-match.ts', 'src/main/literature/pdf-translation/text-generation.test.ts'],
    [
      'src/main/settings/responses-to-chat-completions-bridge.ts',
      'src/main/settings/responses-to-chat-completions-bridge.test.ts'
    ],
    [
      'src/main/settings/classification-settings.ts',
      'src/main/settings/classification-settings.test.ts'
    ],
    [
      'src/main/settings/native-responses-compatibility.ts',
      'src/main/settings/native-responses-compatibility.test.ts'
    ],
    [
      'src/main/literature/pdf-translation/local.ts',
      'src/main/literature/pdf-translation/local.test.ts'
    ],
    [
      'src/main/literature/pdf-translation/text-generation.ts',
      'src/main/literature/pdf-translation/text-generation.test.ts'
    ],
    [
      'src/main/literature/pdf-translation/api-target.ts',
      'src/main/literature/pdf-translation/api-target.test.ts'
    ]
  ]) {
    const plan = createAffectedTestPlan([{ path, status: 'modified' }], graph)
    expect(plan.mode).toBe('selective')
    expect(plan.testFiles).toContain(test)
    expect(plan.testFiles.filter((file) => file.startsWith('packages/providers/'))).toEqual([])
    expect(createPackageTestPlan([path], registry).selected).toEqual([])
  }
  const modules = loadModuleImpactManifest().modules
  for (const [id, module] of Object.entries(modules)) {
    if (module.ownerPaths.some((path) => path.startsWith('src/')))
      expect(
        Object.values(module.testFiles)
          .flat()
          .filter((file) => file.startsWith('packages/providers/')),
        id
      ).toEqual([])
  }
  expect(
    createPackageTestPlan(['packages/diagnostics/src/diagnostic-redaction.ts'], registry).selected
  ).toContain('packages/providers')
  expect(
    createPackageTestPlan(['packages/resilient-download/src/resilient-download.ts'], registry)
      .selected
  ).not.toContain('packages/providers')
  expect(packageVerificationPlan(registry, ['packages/providers'])).toEqual({
    builds: ['packages/diagnostics', 'packages/providers'],
    tests: ['packages/providers']
  })
  const older = {
    ...registry,
    packages: registry.packages.filter((entry) => entry.root !== 'packages/providers')
  }
  expect(createPackageTestPlan(['packages/providers/src/client.ts'], older).excluded).toEqual([])
  expect(
    packageVerificationPlan(
      registry,
      [],
      older.packages.map((entry) => entry.root)
    ).tests
  ).toContain('packages/providers')
  expect(
    createPackageTestPlan(['scripts/check-providers-package.mjs'], registry, { verification: true })
      .selected
  ).toEqual(['packages/providers'])
})
