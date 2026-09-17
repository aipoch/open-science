import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

import { loadModuleImpactManifest } from './load-module-impact.mjs'

// This guard supplements the explicit IPC/behavioral contracts in the manifest. It does not
// claim that imports can discover event dispatch, filesystem protocols or dynamic strings.
it('retains every statically reachable consumer test and declared runtime-loading edge', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
  const tracked = new Set(files)
  const code = files.filter((path) => /\.[cm]?[jt]sx?$/.test(path))
  const reverse = new Map<string, Set<string>>()
  const add = (target: string, consumer: string): void => {
    if (!reverse.has(target)) reverse.set(target, new Set())
    reverse.get(target)!.add(consumer)
  }
  const options: ts.CompilerOptions = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    resolveJsonModule: true,
    baseUrl: process.cwd(),
    // Resolve the local package inside this checkout, not a shared node_modules symlink.
    paths: {
      '@aipoch/notebook-network-sandbox': ['packages/notebook-network-sandbox/src/index.ts'],
      '@aipoch/process-tree-native': ['packages/process-tree-native/index.d.ts'],
      '@aipoch/safe-file-publisher-native': ['packages/safe-file-publisher-native/index.d.ts'],
      '@/*': ['src/renderer/src/*'],
      '@renderer/*': ['src/renderer/src/*']
    }
  }
  const cache = ts.createModuleResolutionCache(process.cwd(), (path) => path, options)
  for (const file of code) {
    const text = readFileSync(file, 'utf8')
    // The TypeScript scanner collects imports, exports, require and dynamic import without
    // building an AST for every implementation file. Mock helpers still need the AST below.
    const specs = new Set(
      ts.preProcessFile(text, true, true).importedFiles.map(({ fileName }) => fileName)
    )
    if (/\b(?:vi\.(?:mock|doMock|importActual)|jest\.mock)\b/.test(text)) {
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false)
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0]) &&
          ['vi.mock', 'vi.doMock', 'vi.importActual', 'jest.mock'].includes(
            node.expression.getText(source)
          )
        )
          specs.add(node.arguments[0].text)
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    for (const spec of specs) {
      const resolved = ts.resolveModuleName(spec, resolve(file), options, ts.sys, cache)
        .resolvedModule?.resolvedFileName
      if (!resolved) continue
      const target = relative(process.cwd(), resolved).split(sep).join('/')
      if (tracked.has(target)) add(target, file)
    }
  }
  const runtimeEdges = JSON.parse(
    readFileSync(resolve('scripts/ci/module-runtime-consumers.json'), 'utf8')
  ) as Record<string, string[]>
  for (const [target, consumers] of Object.entries(runtimeEdges)) {
    expect(tracked.has(target), target).toBe(true)
    for (const consumer of consumers) {
      expect(tracked.has(consumer), consumer).toBe(true)
      add(target, consumer)
    }
  }
  const { modules } = loadModuleImpactManifest(resolve('scripts/ci/module-impact.json')) as {
    modules: Record<
      string,
      {
        ownerPaths: string[]
        interfacePaths: string[]
        fullTestReason?: string
        testFiles: Record<string, string[]>
      }
    >
  }
  const isTest = (path: string): boolean =>
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) && !path.startsWith('e2e/')
  for (const [path, consumers] of reverse) {
    if (!isTest(path) || consumers.size === 0 || !/^(src|packages)\//.test(path)) continue
    expect(
      Object.values(modules).some(
        (module) => module.ownerPaths.includes(path) && module.interfacePaths.includes(path)
      ),
      `${path} exports shared test contracts; register it as an interface to retain consumers`
    ).toBe(true)
  }
  const missing: string[] = []
  for (const [id, module] of Object.entries(modules)) {
    if (module.fullTestReason || id === 'i18n_catalog') continue
    const visited = new Set(
      module.ownerPaths.filter((path) => !isTest(path) || module.interfacePaths.includes(path))
    )
    const pending = [...visited]
    while (pending.length) {
      for (const consumer of reverse.get(pending.pop()!) ?? []) {
        if (visited.has(consumer)) continue
        visited.add(consumer)
        pending.push(consumer)
      }
    }
    const declared = new Set(Object.values(module.testFiles).flat())
    for (const path of visited)
      if (isTest(path) && !declared.has(path)) missing.push(`${id} -> ${path}`)
  }
  expect(missing, 'Add missing owner/contract/consumer evidence to module-impact.json').toEqual([])
}, 60_000)
