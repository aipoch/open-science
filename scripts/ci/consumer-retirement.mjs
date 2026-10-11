/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { posix, resolve } from 'node:path'
import ts from 'typescript'
import { localPackageSourcePaths } from './local-package-exports.mjs'

// Read immutable Git objects, never materialize or execute candidate code. A bounded
// batch also avoids one subprocess per dependency when inspecting a renderer cone.
function snapshot(revision, cwd) {
  const git = (...args) => execFileSync('git', args, { cwd, maxBuffer: 128 * 1024 * 1024 })
  const entries = new Map(
    git('ls-tree', '-r', '-z', revision)
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const [metadata, path] = entry.split('\t')
        const [mode, type, oid] = metadata.split(' ')
        return [path, { mode, type, oid }]
      })
  )
  const ids = [
    ...new Set(
      [...entries]
        .filter(
          ([path, entry]) =>
            /\.(?:[cm]?[jt]sx?|json)$/.test(path) && /^100(?:644|755)$/.test(entry.mode)
        )
        .map(([, entry]) => entry.oid)
    )
  ]
  const batch = execFileSync('git', ['cat-file', '--batch'], {
    cwd,
    input: ids.join('\n') + '\n',
    maxBuffer: 128 * 1024 * 1024
  })
  const contents = new Map()
  let offset = 0
  for (const oid of ids) {
    const newline = batch.indexOf(10, offset)
    const [actual, type, sizeText] = batch.subarray(offset, newline).toString('utf8').split(' ')
    const size = Number(sizeText)
    if (actual !== oid || type !== 'blob' || !Number.isSafeInteger(size) || size < 0)
      throw Error('Incomplete Git source snapshot')
    offset = newline + 1
    if (offset + size >= batch.length) throw Error('Truncated Git source snapshot')
    contents.set(oid, batch.subarray(offset, offset + size).toString('utf8'))
    offset += size + 1
  }
  const read = (path) => {
    const entry = entries.get(path)
    return entry && /^100(?:644|755)$/.test(entry.mode) ? contents.get(entry.oid) : undefined
  }
  return { files: new Set(entries.keys()), read }
}

export function createConsumerDependencyReader(source, runtimeEdges) {
  const root = resolve('/__module_evidence__').replaceAll('\\', '/')
  const key = (path) => posix.relative(root, path.replaceAll('\\', '/'))
  const directories = new Set([root])
  for (const file of source.files) {
    let directory = posix.dirname(posix.join(root, file))
    while (directory.startsWith(root) && !directories.has(directory)) {
      directories.add(directory)
      directory = posix.dirname(directory)
    }
  }
  const host = {
    fileExists: (path) => source.files.has(key(path)),
    readFile: (path) => source.read(key(path)),
    directoryExists: (path) => directories.has(path.replaceAll('\\', '/')),
    realpath: (path) => path,
    getCurrentDirectory: () => root
  }
  const localNames = new Set()
  for (const path of source.files) {
    if (!/^packages\/[^/]+\/package\.json$/.test(path)) continue
    const manifest = JSON.parse(source.read(path))
    if (manifest.name) localNames.add(manifest.name)
  }
  const packageManifest = source.read('package.json')
  if (packageManifest) {
    const manifest = JSON.parse(packageManifest)
    for (const [name, value] of Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies
    }))
      if (/^(?:file:|link:|workspace:)/.test(value)) localNames.add(name)
  }
  const packagePaths = source.files.has('scripts/ci/package-test-boundaries.json')
    ? localPackageSourcePaths(root, { existsSync: host.fileExists, readFileSync: host.readFile })
    : {}
  const options = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    resolveJsonModule: true,
    baseUrl: root,
    paths: {
      ...packagePaths,
      '@aipoch/notebook-network-sandbox': ['packages/notebook-network-sandbox/src/index.ts'],
      '@aipoch/process-tree-native': ['packages/process-tree-native/index.d.ts'],
      '@aipoch/safe-file-publisher-native': ['packages/safe-file-publisher-native/index.d.ts'],
      '@/*': ['src/renderer/src/*'],
      '@renderer/*': ['src/renderer/src/*']
    }
  }
  const resolutionCache = ts.createModuleResolutionCache(root, (path) => path, options)
  const parsed = new Map()
  const explicit = new Map()
  for (const [target, consumers] of runtimeEdges) {
    for (const consumer of consumers) {
      if (!explicit.has(consumer)) explicit.set(consumer, new Set())
      explicit.get(consumer).add(target)
    }
  }
  const dependencies = (path) => {
    if (parsed.has(path)) return parsed.get(path)
    const result = { paths: new Set(explicit.get(path)), complete: true }
    parsed.set(path, result)
    const text = source.read(path)
    if (text === undefined) {
      result.complete = false
      return result
    }
    if (path.endsWith('.json')) return result
    const specs = new Set(
      ts.preProcessFile(text, true, true).importedFiles.map(({ fileName }) => fileName)
    )
    const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
    if (ast.parseDiagnostics.length) result.complete = false
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression.getText(ast)
        if (
          node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          [
            'require',
            'require.resolve',
            'vi.mock',
            'vi.doMock',
            'vi.importActual',
            'jest.mock'
          ].includes(expression)
        ) {
          const argument = node.arguments[0]
          if (
            argument &&
            (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
          )
            specs.add(argument.text)
          else result.complete = false
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    for (const spec of specs) {
      const resolved = ts.resolveModuleName(
        spec,
        posix.join(root, path),
        options,
        host,
        resolutionCache
      ).resolvedModule?.resolvedFileName
      if (resolved && source.files.has(key(resolved))) result.paths.add(key(resolved))
      else if (
        spec.startsWith('.') ||
        spec.startsWith('/') ||
        spec.startsWith('@/') ||
        spec.startsWith('@renderer/') ||
        spec.startsWith('@aipoch/') ||
        [...localNames].some((name) => spec === name || spec.startsWith(name + '/'))
      )
        result.complete = false
    }
    return result
  }
  return (test, owners) => {
    const pending = [test],
      visited = new Set()
    let complete = true
    while (pending.length) {
      const path = pending.pop()
      if (visited.has(path)) continue
      if (owners.has(path)) return { reachable: true, complete }
      visited.add(path)
      const next = dependencies(path)
      complete &&= next.complete
      pending.push(...next.paths)
    }
    return { reachable: false, complete }
  }
}

// Exceptions are derived by trusted code from both revisions, never a candidate flag.
// Only consumer evidence can retire; existing owner/interface/contract protections stay intact.
export function verifiedConsumerRetirements(
  base,
  head,
  baseManifest,
  headManifest,
  { cwd = process.cwd() } = {}
) {
  const candidates = Object.entries(baseManifest.modules).flatMap(([id, owner]) => {
    const current = headManifest.modules[id]
    return current
      ? owner.testFiles.consumer
          .filter((test) => !current.testFiles.consumer.includes(test))
          .map((test) => ({ id, test, owner, current }))
      : []
  })
  if (!candidates.length) return new Set()
  try {
    const before = snapshot(base, cwd),
      after = snapshot(head, cwd)
    // Preserve trusted dynamic/source-read evidence even if the candidate deletes it.
    const runtimeEdges = [before, after].flatMap((source) => {
      const text = source.read('scripts/ci/module-runtime-consumers.json')
      return text ? Object.entries(JSON.parse(text)) : []
    })
    const previousDependencies = createConsumerDependencyReader(before, runtimeEdges)
    const currentDependencies = createConsumerDependencyReader(after, runtimeEdges)
    const retired = new Set()
    for (const { id, test, owner, current } of candidates) {
      if (
        !before.files.has(test) ||
        !after.files.has(test) ||
        owner.fullTestReason ||
        current.fullTestReason
      )
        continue
      const owners = new Set([...owner.ownerPaths, ...current.ownerPaths])
      if (!previousDependencies(test, owners).reachable) continue
      const result = currentDependencies(test, owners)
      if (result.complete && !result.reachable) retired.add(`${id}:${test}`)
    }
    return retired
  } catch {
    // Missing/unsupported evidence retains the original registration obligation.
    return new Set()
  }
}

// Absence from an import graph is only a proof when the entire consumer cone is understood.
// Keep uncertain evidence (including generated native addons) rather than demand its deletion.
export function provablyStaleConsumerTests(owner, inspect) {
  const owners = new Set(owner.ownerPaths)
  return owner.testFiles.consumer.filter((test) => {
    const result = inspect(test, owners)
    return result.complete && !result.reachable
  })
}
