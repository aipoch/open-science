/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { posix, resolve } from 'node:path'
import ts from 'typescript'
import {
  boundaryViolations,
  dependencyConsumerBoundaries,
  usesDependencyConsumers
} from './module-derived-consumers.mjs'
import { localPackageSourcePaths } from './local-package-exports.mjs'
import { createPackageTestPlan, validatePackageTestRegistry } from './package-test-impact.mjs'

export function isConsumerSourcePath(path) {
  return /\.(?:[cm]?[jt]sx?|json)$/.test(path)
}

// Read immutable Git objects, never materialize or execute candidate code. A bounded
// batch also avoids one subprocess per dependency when inspecting a renderer cone.
export function sourceSnapshot(revision, cwd) {
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
          ([path, entry]) => isConsumerSourcePath(path) && /^100(?:644|755)$/.test(entry.mode)
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

// Empty imports/exports can execute side effects; only explicitly typed bindings erase.
export function isTypeOnlyDependency(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause
    const bindings = clause?.namedBindings
    return Boolean(
      clause?.isTypeOnly ||
      (clause &&
        !clause.name &&
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((element) => element.isTypeOnly))
    )
  }
  return (
    ts.isExportDeclaration(node) &&
    (node.isTypeOnly ||
      (node.exportClause &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.length > 0 &&
        node.exportClause.elements.every((element) => element.isTypeOnly)))
  )
}

export function createConsumerDependencyReader(
  source,
  runtimeEdges,
  {
    staticOnly = false,
    runtimeOnly = false,
    externalImports = [],
    literalLoaders = false,
    strictExternalImports = false,
    resourceImports = [],
    reviewedSyntax = false
  } = {}
) {
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
      '@aipoch/credential-identity-probe-native': [
        'packages/credential-identity-probe-native/index.d.ts'
      ],
      '@/*': ['src/renderer/src/*'],
      '@renderer/*': ['src/renderer/src/*']
    }
  }
  const resolutionCache = ts.createModuleResolutionCache(root, (path) => path, options)
  const parsed = new Map()
  const assetPath = (specifier, importer) => {
    const match =
      /^([^?#]+\.(?:svg|png|jpe?g|gif|webp|avif|ico|css))(?:\?(?:raw|url|inline|no-inline))?(?:#[^?]*)?$/.exec(
        specifier
      )
    const reviewed = resourceImports.length
      ? /^([^?#]+)(?:\?(?:raw|url|inline|no-inline|asset))?(?:#[^?]*)?$/.exec(specifier)
      : undefined
    if (!match && !reviewed) return undefined
    const path = (match ?? reviewed)[1]
    const candidate = path.startsWith('@/')
      ? posix.join('src/renderer/src', path.slice(2))
      : path.startsWith('@renderer/')
        ? posix.join('src/renderer/src', path.slice(10))
        : path.startsWith('.')
          ? posix.join(posix.dirname(importer), path)
          : undefined
    return candidate &&
      source.files.has(candidate) &&
      (match || resourceImports.includes(candidate))
      ? candidate
      : undefined
  }
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
    // Resources can contain further URLs/imports. Their known edges add coverage, but
    // never prove that unrelated consumers can retire; do not parse binary data as TS.
    if (!isConsumerSourcePath(path)) {
      result.complete = false
      return result
    }
    const text = source.read(path)
    if (text === undefined) {
      result.complete = false
      return result
    }
    if (path.endsWith('.json')) return result
    const specs = new Set(
      runtimeOnly
        ? []
        : ts.preProcessFile(text, true, true).importedFiles.map(({ fileName }) => fileName)
    )
    const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
    if (ast.parseDiagnostics.length) result.complete = false
    // Module exposes indirect loaders too (_load, Module.prototype.require, etc.).
    // Only known read-only introspection is safe to exclude from opaque loading.
    const harmlessModuleMembers = new Set(['builtinModules', 'isBuiltin'])
    const importedLoaders = new Set()
    const requireFactories = new Set()
    const moduleNamespaces = new Set()
    for (const statement of ast.statements) {
      if (
        ts.isImportEqualsDeclaration(statement) &&
        !statement.isTypeOnly &&
        ts.isExternalModuleReference(statement.moduleReference) &&
        ['node:module', 'module'].includes(statement.moduleReference.expression?.text)
      )
        moduleNamespaces.add(statement.name.text)
      if (
        ts.isExportDeclaration(statement) &&
        !statement.isTypeOnly &&
        ['node:module', 'module'].includes(statement.moduleSpecifier?.text)
      )
        result.complete = false
      if (
        !ts.isImportDeclaration(statement) ||
        !['node:module', 'module'].includes(statement.moduleSpecifier.text) ||
        statement.importClause?.isTypeOnly
      )
        continue
      const clause = statement.importClause
      if (clause?.name) moduleNamespaces.add(clause.name.text)
      const bindings = clause?.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) moduleNamespaces.add(bindings.name.text)
      if (bindings && ts.isNamedImports(bindings))
        for (const binding of bindings.elements) {
          if (
            literalLoaders &&
            !binding.isTypeOnly &&
            (binding.propertyName ?? binding.name).text === 'createRequire'
          )
            requireFactories.add(binding.name.text)
          if (
            !binding.isTypeOnly &&
            !harmlessModuleMembers.has((binding.propertyName ?? binding.name).text)
          )
            importedLoaders.add(binding.name.text)
        }
    }
    const requireFactory = (node) =>
      literalLoaders &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      requireFactories.has(node.expression.text) &&
      node.arguments.length === 1 &&
      node.arguments[0].getText(ast) === 'import.meta.url'
    const localRequires = new Set()
    const collectRequires = (node) => {
      if (
        literalLoaders &&
        ts.isIdentifier(node) &&
        node.text === 'process' &&
        node.parent.name === node &&
        (ts.isVariableDeclaration(node.parent) ||
          ts.isParameter(node.parent) ||
          ts.isBindingElement(node.parent) ||
          ts.isFunctionDeclaration(node.parent) ||
          ts.isFunctionExpression(node.parent) ||
          ts.isClassDeclaration(node.parent) ||
          ts.isClassExpression(node.parent) ||
          ts.isEnumDeclaration(node.parent) ||
          ts.isModuleDeclaration(node.parent) ||
          ts.isImportSpecifier(node.parent) ||
          ts.isImportClause(node.parent) ||
          ts.isNamespaceImport(node.parent) ||
          ts.isImportEqualsDeclaration(node.parent))
      )
        result.complete = false
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        requireFactory(node.initializer) &&
        node.parent.flags & ts.NodeFlags.Const &&
        !node.parent.parent.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
        )
      )
        localRequires.add(node.name.text)
      ts.forEachChild(node, collectRequires)
    }
    collectRequires(ast)
    const requireValue = (node) =>
      requireFactory(node) || (ts.isIdentifier(node) && localRequires.has(node.text))
    const literalLoaderCall = (node) =>
      literalLoaders &&
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      (requireValue(node.expression) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'resolve' &&
          requireValue(node.expression.expression)) ||
        node.expression.getText(ast) === 'process.getBuiltinModule')
    const loaderUse = (node) =>
      (literalLoaderCall(node.parent) && node.parent.expression === node) ||
      (ts.isPropertyAccessExpression(node.parent) &&
        node.parent.expression === node &&
        literalLoaderCall(node.parent.parent))
    const containsProcess = (node) =>
      (ts.isIdentifier(node) && node.text === 'process') || ts.forEachChild(node, containsProcess)
    // Boundary review may distinguish ordinary parameter/property names from ambient
    // loaders. Keep the independent-history proof reader conservative by default.
    let localChecker
    const localValueName = (node) => {
      if (!reviewedSyntax || !ts.isIdentifier(node)) return false
      if (!localChecker) {
        // Bind only this already-parsed candidate file; never resolve or execute imports.
        const options = { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest }
        const host = ts.createCompilerHost(options)
        host.getSourceFile = (name) => (name === path ? ast : undefined)
        host.readFile = () => undefined
        host.fileExists = (name) => name === path
        localChecker = ts.createProgram([path], options, host).getTypeChecker()
      }
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? localChecker.getShorthandAssignmentValueSymbol(node.parent)
        : localChecker.getSymbolAtLocation(node)
      const declaration = symbol?.valueDeclaration
      return (
        !!declaration &&
        (ts.isParameter(declaration) ||
          ts.isVariableDeclaration(declaration) ||
          ts.isBindingElement(declaration))
      )
    }
    const propertyName = (node) =>
      reviewedSyntax &&
      node.parent.name === node &&
      ((ts.isPropertyAccessExpression(node.parent) && localValueName(node.parent.expression)) ||
        ts.isPropertyAssignment(node.parent) ||
        ts.isMethodDeclaration(node.parent) ||
        ts.isPropertyDeclaration(node.parent))
    const visit = (node) => {
      if (
        literalLoaders &&
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        containsProcess(node.left)
      )
        result.complete = false
      // An opted-in loader must remain a local const used only for literal calls/resolution.
      // Never accept aliases escaping into another function, assignments or shadow bindings.
      if (literalLoaders && ts.isIdentifier(node)) {
        if (
          localRequires.has(node.text) &&
          !loaderUse(node) &&
          !(
            ts.isVariableDeclaration(node.parent) &&
            node.parent.name === node &&
            node.parent.initializer &&
            requireFactory(node.parent.initializer) &&
            node.parent.parent.flags & ts.NodeFlags.Const &&
            !node.parent.parent.parent.modifiers?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
            )
          )
        )
          result.complete = false
        if (
          requireFactories.has(node.text) &&
          !ts.isImportSpecifier(node.parent) &&
          !(
            requireFactory(node.parent) &&
            (loaderUse(node.parent) ||
              (ts.isVariableDeclaration(node.parent.parent) &&
                localRequires.has(node.parent.parent.name.text)))
          )
        )
          result.complete = false
      }
      // Keep value imports conservative, including mixed named type/value imports and export *.
      // Type references still belong to the default structural graph and typecheck scope.
      if (runtimeOnly) {
        if (ts.isImportTypeNode(node)) return
        if (ts.isImportDeclaration(node) && !isTypeOnlyDependency(node))
          specs.add(node.moduleSpecifier.text)
        if (ts.isExportDeclaration(node) && node.moduleSpecifier && !isTypeOnlyDependency(node))
          specs.add(node.moduleSpecifier.text)
        if (
          ts.isImportEqualsDeclaration(node) &&
          !node.isTypeOnly &&
          ts.isExternalModuleReference(node.moduleReference) &&
          ts.isStringLiteral(node.moduleReference.expression)
        )
          specs.add(node.moduleReference.expression.text)
      }
      if (
        ts.isTypeNode(node) ||
        ts.isImportDeclaration(node) ||
        ts.isImportEqualsDeclaration(node) ||
        ts.isInterfaceDeclaration(node)
      )
        return
      // Test pruning needs stronger evidence than registration auditing: these globals
      // can reach IPC, external processes or filesystem resources without an import edge.
      if (
        staticOnly &&
        ts.isIdentifier(node) &&
        [
          'window',
          'globalThis',
          'global',
          'process',
          'fetch',
          'Worker',
          'WebSocket',
          'XMLHttpRequest',
          'eval',
          'Function',
          'require',
          'document',
          'navigator',
          'self'
        ].includes(node.text) &&
        !(node.text === 'document' && propertyName(node)) &&
        !(node.text === 'document' && localValueName(node))
      )
        result.complete = false
      // A loader passed as a value escapes literal-call import discovery. Without scope
      // proof, a local binding named module also stays opaque rather than hiding a loader.
      if (
        ts.isIdentifier(node) &&
        (['require', 'eval', 'Function', 'getBuiltinModule', 'mainModule'].includes(node.text) ||
          (node.text === 'module' &&
            !localValueName(node) &&
            !(
              (ts.isPropertyAccessExpression(node.parent) ||
                ts.isPropertyAssignment(node.parent)) &&
              node.parent.name === node
            )) ||
          importedLoaders.has(node.text) ||
          moduleNamespaces.has(node.text))
      ) {
        const parent = node.parent
        const directRequire =
          node.text === 'require' &&
          !importedLoaders.has(node.text) &&
          !moduleNamespaces.has(node.text) &&
          ((ts.isCallExpression(parent) && parent.expression === node) ||
            (ts.isPropertyAccessExpression(parent) &&
              parent.expression === node &&
              parent.name.text === 'resolve' &&
              ts.isCallExpression(parent.parent) &&
              parent.parent.expression === parent))
        const assertion =
          node.text === 'Function' &&
          ts.isCallExpression(parent) &&
          parent.expression.getText(ast) === 'expect.any' &&
          parent.arguments[0] === node
        const moduleProperty =
          moduleNamespaces.has(node.text) &&
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === node &&
          harmlessModuleMembers.has(parent.name.text)
        const reviewedFactory =
          requireFactories.has(node.text) &&
          requireFactory(node.parent) &&
          (loaderUse(node.parent) ||
            (ts.isVariableDeclaration(node.parent.parent) &&
              localRequires.has(node.parent.parent.name.text)))
        const reviewedBuiltin =
          node.text === 'getBuiltinModule' &&
          ts.isPropertyAccessExpression(parent) &&
          literalLoaderCall(parent.parent)
        const reviewedRequire = literalLoaders && localRequires.has(node.text)
        if (
          !directRequire &&
          !assertion &&
          !moduleProperty &&
          !reviewedFactory &&
          !reviewedBuiltin &&
          !reviewedRequire
        )
          result.complete = false
      }
      if (
        ts.isElementAccessExpression(node) &&
        ((ts.isStringLiteral(node.argumentExpression) &&
          ['require', 'eval', 'Function', 'getBuiltinModule', 'mainModule'].includes(
            node.argumentExpression.text
          )) ||
          (ts.isIdentifier(node.expression) &&
            ['globalThis', 'window', 'global', ...(literalLoaders ? ['process'] : [])].includes(
              node.expression.text
            ) &&
            !ts.isStringLiteral(node.argumentExpression)))
      )
        result.complete = false
      if (ts.isCallExpression(node)) {
        const expression = node.expression.getText(ast)
        if (
          node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          literalLoaderCall(node) ||
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
          ) {
            specs.add(argument.text)
            if (['node:module', 'module'].includes(argument.text)) result.complete = false
          } else result.complete = false
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    for (const spec of specs) {
      const asset = assetPath(spec, path)
      if (asset) {
        result.paths.add(asset)
        // Only reviewed boundary selection may rely on separately pinned resource coverage.
        // Independent-history proofs never opt in: CSS/HTML can contain further references.
        if (!resourceImports.includes(asset)) result.complete = false
        continue
      }
      const resolved = ts.resolveModuleName(
        spec,
        posix.join(root, path),
        options,
        host,
        resolutionCache
      ).resolvedModule?.resolvedFileName
      if (resolved && source.files.has(key(resolved))) result.paths.add(key(resolved))
      else if (
        ((staticOnly || runtimeOnly) &&
          !externalImports.includes(spec) &&
          !(
            !strictExternalImports &&
            [
              'vitest',
              'react',
              'react/jsx-runtime',
              'react-dom',
              'react-dom/client',
              'react-dom/server',
              '@testing-library/react',
              '@testing-library/user-event',
              'node:path',
              'node:url',
              'node:util',
              'node:assert',
              'node:assert/strict'
            ].includes(spec)
          )) ||
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
  const inspect = (test, owners) => {
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
      // Static-only callers retain uncertain tests; no further traversal can permit omission.
      if (staticOnly && !complete) return { reachable: false, complete: false }
      pending.push(...next.paths)
    }
    return { reachable: false, complete }
  }
  // Expose the same resolver for bounded host-adapter selection and explainable audits.
  inspect.dependencies = dependencies
  return inspect
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
    const before = sourceSnapshot(base, cwd),
      after = sourceSnapshot(head, cwd)
    // Preserve trusted dynamic/source-read evidence even if the candidate deletes it.
    const runtimeEdges = [before, after].flatMap((source) => {
      const text = source.read('scripts/ci/module-runtime-consumers.json')
      return text ? Object.entries(JSON.parse(text)) : []
    })
    const previousDependencies = createConsumerDependencyReader(before, runtimeEdges)
    const currentDependencies = createConsumerDependencyReader(after, runtimeEdges)
    // Already-independent host history can retire only in a consumer-removal-only change.
    // Do not let concurrent source, test, runtime-edge or checker edits manufacture evidence.
    let registrationOnly
    const isRegistrationOnly = () => {
      if (registrationOnly === undefined) {
        const changed = execFileSync(
          'git',
          ['diff', '--no-renames', '--name-only', '-z', base, head],
          { cwd, encoding: 'utf8' }
        )
          .split('\0')
          .filter(Boolean)
        registrationOnly =
          changed.length > 0 &&
          changed.every((path) =>
            /^scripts\/ci\/module-impact(?:\.json|\/[a-z][a-z0-9_]*\.json)$/.test(path)
          ) &&
          Object.keys(baseManifest.modules).length === Object.keys(headManifest.modules).length &&
          Object.entries(baseManifest.modules).every(([id, original]) => {
            const current = headManifest.modules[id]
            return (
              current &&
              current.testFiles.consumer.every((test) =>
                original.testFiles.consumer.includes(test)
              ) &&
              isDeepStrictEqual(
                {
                  ...original,
                  testFiles: { ...original.testFiles, consumer: current.testFiles.consumer }
                },
                current
              )
            )
          })
      }
      return registrationOnly
    }
    const previousRuntimeDependencies = createConsumerDependencyReader(before, runtimeEdges, {
      staticOnly: true,
      runtimeOnly: true
    })
    const currentRuntimeDependencies = createConsumerDependencyReader(after, runtimeEdges, {
      staticOnly: true,
      runtimeOnly: true
    })
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
      const previous = previousDependencies(test, owners)
      // Already-independent history needs complete evidence in both revisions and
      // a retained original test owner; host cleanup additionally excludes code edits.
      if (!previous.reachable) {
        if (/^src\/(?:main|renderer)\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(test)) {
          const testOwners = (manifest) =>
            Object.entries(manifest.modules).filter(([, module]) =>
              module.ownerPaths.includes(test)
            )
          // Structural evidence still protects type dependencies; erased type bodies do not
          // execute opaque filesystem/IPC access. Require strict evidence for the runtime cone.
          const previousRuntime = previousRuntimeDependencies(test, owners)
          const currentRuntime = currentRuntimeDependencies(test, owners)
          const originalOwners = testOwners(baseManifest)
          const currentOwners = testOwners(headManifest)
          if (
            !previous.complete ||
            !previousRuntime.complete ||
            previousRuntime.reachable ||
            !currentRuntime.complete ||
            currentRuntime.reachable ||
            !isRegistrationOnly() ||
            originalOwners.length !== 1 ||
            currentOwners.length !== 1 ||
            originalOwners[0][0] === id ||
            originalOwners[0][0] !== currentOwners[0][0] ||
            !originalOwners[0][1].testFiles.owner.includes(test) ||
            !currentOwners[0][1].testFiles.owner.includes(test)
          )
            continue
        } else {
          const root = /^packages\/[^/]+\//.exec(test)?.[0]
          const packageOwners = Object.entries(baseManifest.modules).filter(
            ([, module]) =>
              module.ownerPaths.includes(test) && module.testFiles.owner.includes(test)
          )
          if (
            !root ||
            !previous.complete ||
            !before.files.has(`${root}package.json`) ||
            !after.files.has(`${root}package.json`) ||
            [...owners].some((path) => path.startsWith(root)) ||
            packageOwners.length !== 1 ||
            !headManifest.modules[packageOwners[0][0]]?.ownerPaths.includes(test) ||
            !headManifest.modules[packageOwners[0][0]]?.testFiles.owner.includes(test)
          )
            continue
        }
      }
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

// Reviewed pure-helper boundaries, never a general exemption for shared contracts.
// The original full owner and all of its evidence remain protected by the ordinary checker.
export function verifiedPdfTextOwnerSplit(base, head, baseManifest, headManifest, options = {}) {
  return verifiedPureHelperSplit(
    base,
    head,
    baseManifest,
    headManifest,
    'pdf_text',
    'pdf-text',
    options
  )
}

export function verifiedPromiseIdentityOwnerSplit(
  base,
  head,
  baseManifest,
  headManifest,
  options = {}
) {
  return verifiedPureHelperSplit(
    base,
    head,
    baseManifest,
    headManifest,
    'shared_promise_identity',
    'in-flight-promise',
    options
  )
}

export function verifiedFuzzyMatchOwnerSplit(base, head, baseManifest, headManifest, options = {}) {
  // Its existing behavior suite belongs to the composer facade and must keep that owner.
  if (
    !headManifest.modules.shared_fuzzy_match?.testFiles.consumer.includes(
      'src/renderer/src/pages/workspace/composer/fuzzy-match.test.ts'
    )
  )
    return new Set()
  return verifiedPureHelperSplit(
    base,
    head,
    baseManifest,
    headManifest,
    'shared_fuzzy_match',
    'fuzzy-match',
    options,
    false
  )
}

function verifiedPureHelperSplit(
  base,
  head,
  baseManifest,
  headManifest,
  targetId,
  file,
  { cwd = process.cwd() } = {},
  includeOwnerTest = true
) {
  const originalId = 'shared_application_contracts'
  const paths = [`src/shared/${file}.ts`]
  if (includeOwnerTest) paths.push(`src/shared/${file}.test.ts`)
  const original = baseManifest.modules[originalId]
  const remaining = headManifest.modules[originalId]
  const target = headManifest.modules[targetId]
  if (!original?.fullTestReason || !remaining || !target || baseManifest.modules[targetId])
    return new Set()
  try {
    // This transition may only change registration data, never the code used as proof.
    const changed = execFileSync('git', ['diff', '--name-only', '-z', base, head], { cwd })
      .toString()
      .split('\0')
      .filter(Boolean)
    if (changed.some((path) => !/^scripts\/ci\/module-impact\/[a-z][a-z0-9_]*\.json$/.test(path)))
      return new Set()
    if (
      target.fullTestReason !== undefined ||
      target.ownerPaths.length !== paths.length ||
      !paths.every(
        (path) =>
          original.ownerPaths.includes(path) &&
          target.ownerPaths.includes(path) &&
          !remaining.ownerPaths.includes(path)
      ) ||
      !target.interfacePaths.includes(paths[0]) ||
      !paths
        .filter((path) => original.interfacePaths.includes(path))
        .every((path) => target.interfacePaths.includes(path)) ||
      (includeOwnerTest && !target.testFiles.owner.includes(paths[1])) ||
      target.fallbackCapability !== original.fallbackCapability ||
      !original.capabilityOverlays.every((overlay) =>
        target.capabilityOverlays.includes(overlay)
      ) ||
      !original.consumerModules.every((consumer) => target.consumerModules.includes(consumer))
    )
      return new Set()
    const before = sourceSnapshot(base, cwd),
      after = sourceSnapshot(head, cwd)
    if (
      !paths.every(
        (path) => before.read(path) !== undefined && before.read(path) === after.read(path)
      )
    )
      return new Set()
    const edges = [before, after].flatMap((source) =>
      Object.entries(JSON.parse(source.read('scripts/ci/module-runtime-consumers.json')))
    )
    const inspectors = [before, after].map((source) =>
      createConsumerDependencyReader(source, edges, { staticOnly: true })
    )
    // These helpers must remain pure utilities. If its boundary acquires opaque inputs, retain full.
    if (inspectors.some((inspect) => !inspect(paths[0], new Set()).complete)) return new Set()
    const evidence = new Set(Object.values(target.testFiles).flat())
    const originalEvidence = Object.values(original.testFiles).flat()
    // Legacy paired source/test exceptions retain their full evidence inheritance.
    // The source-only fuzzy boundary uses the required composer suite and the complete
    // reachability proof below; ordinary checks still protect the remaining full owner.
    if (includeOwnerTest && originalEvidence.some((test) => !evidence.has(test))) return new Set()
    const owners = new Set(paths)
    // Keep the existing trusted package direction: host-only edits do not run independent
    // upstream package suites. Candidate registry changes are forbidden in this transition.
    const excludedPackages = createPackageTestPlan(
      paths,
      JSON.parse(before.read('scripts/ci/package-test-boundaries.json'))
    ).excluded
    const tests = new Set(
      [before, after].flatMap((source) =>
        [...source.files].filter(
          (path) => !path.startsWith('e2e/') && /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
        )
      )
    )
    for (const test of tests) {
      if (evidence.has(test)) continue
      if (excludedPackages.some((root) => test.startsWith(root + '/'))) continue
      if (
        inspectors.some((inspect) => {
          const result = inspect(test, owners)
          return result.reachable || !result.complete
        })
      )
        return new Set()
    }
    return new Set(paths.map((path) => `${originalId}:${path}`))
  } catch {
    return new Set()
  }
}

// Historical cross-package contract evidence can also be redundant: the trusted selector already
// excludes that package for every owner edit. This is not permission to reduce coverage
// based only on a candidate registry or an absent static import.
export function verifiedExcludedPackageTests(
  base,
  head,
  baseManifest,
  headManifest,
  { cwd = process.cwd() } = {}
) {
  const candidates = Object.entries(baseManifest.modules).flatMap(([id, owner]) => {
    const current = headManifest.modules[id]
    return current
      ? owner.testFiles.contract
          .filter((test) => !current.testFiles.contract.includes(test))
          .map((test) => ({ id, test, owner, current }))
      : []
  })
  if (!candidates.length) return new Set()
  try {
    const before = sourceSnapshot(base, cwd),
      after = sourceSnapshot(head, cwd)
    const registry = validatePackageTestRegistry(
      JSON.parse(before.read('scripts/ci/package-test-boundaries.json'))
    )
    const manifests = registry.packages.map((entry) => ({
      ...entry,
      manifest: JSON.parse(before.read(`${entry.root}/package.json`))
    }))
    for (const entry of manifests) {
      if (!entry.manifest.name || !entry.manifest.scripts?.test) return new Set()
      const dependencies = {
        ...entry.manifest.dependencies,
        ...entry.manifest.devDependencies,
        ...entry.manifest.peerDependencies,
        ...entry.manifest.optionalDependencies
      }
      if (
        manifests.some(
          (upstream) =>
            upstream.root !== entry.root &&
            Object.hasOwn(dependencies, upstream.manifest.name) &&
            !entry.dependencies.includes(upstream.root)
        )
      )
        return new Set()
    }
    const runtimeEdges = [before, after].flatMap((source) => {
      const text = source.read('scripts/ci/module-runtime-consumers.json')
      return text ? Object.entries(JSON.parse(text)) : []
    })
    const previousDependencies = createConsumerDependencyReader(before, runtimeEdges)
    const currentDependencies = createConsumerDependencyReader(after, runtimeEdges)
    const retired = new Set()
    for (const { id, test, owner, current } of candidates) {
      const root = registry.packages.find((entry) => test.startsWith(entry.root + '/'))?.root
      if (
        !root ||
        !/\.(test|spec)\.[cm]?[jt]sx?$/.test(test) ||
        owner.fullTestReason ||
        current.fullTestReason
      )
        continue
      // Keep a unique owner, independent owner-test coverage and the actual test file.
      const owning = (manifest) =>
        Object.entries(manifest.modules).filter(
          ([, m]) => m.ownerPaths.includes(test) && m.testFiles.owner.includes(test)
        )
      const previousOwners = owning(baseManifest),
        currentOwners = owning(headManifest)
      if (
        !before.files.has(test) ||
        !after.files.has(test) ||
        previousOwners.length !== 1 ||
        currentOwners.length !== 1 ||
        previousOwners[0][0] !== currentOwners[0][0] ||
        previousOwners[0][0] === id
      )
        continue
      const owners = new Set([...owner.ownerPaths, ...current.ownerPaths])
      if (
        !owners.size ||
        [...owners].some((path) => !/^(src|packages)\//.test(path)) ||
        !createPackageTestPlan([...owners], registry).excluded.includes(root)
      )
        continue
      const previous = previousDependencies(test, owners)
      const result = currentDependencies(test, owners)
      if (previous.complete && !previous.reachable && result.complete && !result.reachable)
        retired.add(`${id}:contract:${test}`)
    }
    return retired
  } catch {
    return new Set()
  }
}

// This is an explicit dependency-model policy, NOT a proof that opaque consumer cones are
// independent. Only reviewed source boundaries may trade inherited history for known edges.
export function dependencyBoundaryViolations(
  source,
  manifest,
  baseManifest = manifest,
  runtimeEdges
) {
  let edges, strict, inspect
  try {
    edges =
      runtimeEdges ??
      Object.entries(JSON.parse(source.read('scripts/ci/module-runtime-consumers.json') ?? '{}'))
    strict = createConsumerDependencyReader(source, edges, {
      staticOnly: true,
      runtimeOnly: true
    })
    inspect = createConsumerDependencyReader(source, edges)
  } catch (error) {
    return [
      {
        path: 'scripts/ci/module-impact.json',
        rule: 'dependency-consumer-boundary',
        message: `Cannot validate dependency evidence: ${error.message}`
      }
    ]
  }
  const violations = []
  // Inspect structural edges too: erased type imports must not reverse a layer.
  const structuralEdges = new Map()
  const pending = Object.entries(dependencyConsumerBoundaries).flatMap(([id, boundary]) =>
    manifest.modules[id] && !manifest.modules[id].fullTestReason ? boundary.sources : []
  )
  while (pending.length) {
    const path = pending.pop()
    if (structuralEdges.has(path) || !source.files.has(path)) continue
    const targets = inspect.dependencies(path).paths
    structuralEdges.set(path, targets)
    pending.push(...targets)
  }
  for (const message of boundaryViolations(structuralEdges, manifest.modules))
    violations.push({
      path: 'scripts/ci/module-impact.json',
      rule: 'dependency-consumer-boundary',
      message
    })
  for (const [id, boundary] of Object.entries(dependencyConsumerBoundaries)) {
    const module = manifest.modules[id]
    if (!module || module.fullTestReason) continue
    const reject = (message) =>
      violations.push({
        path: `scripts/ci/module-impact/${id}.json`,
        rule: 'dependency-consumer-boundary',
        message
      })
    const directRuntime = createConsumerDependencyReader(source, edges, {
      runtimeOnly: true,
      externalImports: boundary.externalImports,
      literalLoaders: boundary.literalLoaders,
      resourceImports: boundary.resourceImports,
      reviewedSyntax: true
    })
    const directCodec = createConsumerDependencyReader(source, edges, {
      runtimeOnly: true,
      staticOnly: true,
      reviewedSyntax: true,
      externalImports: boundary.externalImports
    })
    // Low-level files in a mixed owner cannot borrow its filesystem/process permissions.
    const policyReaders = new Map()
    const directPolicy = (path) => {
      const imports = boundary.pureExternalImports?.[path] ?? []
      const key = JSON.stringify(imports)
      if (!policyReaders.has(key))
        policyReaders.set(
          key,
          createConsumerDependencyReader(source, edges, {
            runtimeOnly: true,
            staticOnly: true,
            strictExternalImports: true,
            reviewedSyntax: true,
            externalImports: [
              'zod',
              'node:buffer',
              'node:path',
              'node:url',
              'node:util',
              ...imports
            ]
          })
        )
      return policyReaders.get(key)
    }

    if (
      !usesDependencyConsumers(id, module) ||
      // Resource inputs keep exact ownership and explicit behavior/packaging tests. A new
      // asset or fixture cannot silently inherit approval from a directory-wide pattern.
      [...(boundary.resourcePaths ?? []), ...(boundary.resourceImports ?? [])].some(
        (path) => !source.files.has(path)
      ) ||
      ((boundary.resourcePaths?.length || boundary.resourceImports?.length) &&
        (!boundary.resourceTests?.length ||
          boundary.resourceTests.some((test) => !boundary.requiredTests?.includes(test)))) ||
      Object.entries(boundary.pureExternalImports ?? {}).some(
        ([path, imports]) =>
          !boundary.sources.includes(path) ||
          !Array.isArray(imports) ||
          imports.some(
            (specifier) =>
              !['clsx', 'tailwind-merge', 'diff', 'marked', 'parse5'].includes(specifier)
          )
      ) ||
      boundary.sources.some((path) =>
        boundary.externalImports
          ? !(
              ['policy', 'domain-contract', 'presentation-model'].includes(
                boundary.sourceLayers?.[path] ?? boundary.layer
              )
                ? directPolicy(path)
                : ['record-codec', 'record-contract', 'bootstrap-state'].includes(
                      boundary.sourceLayers?.[path] ?? boundary.layer
                    )
                  ? directCodec
                  : directRuntime
            ).dependencies(path).complete
          : !strict(path, new Set()).complete
      ) ||
      (boundary.requiredTests ?? []).some(
        (test) =>
          source.read(test) === undefined || !Object.values(module.testFiles).flat().includes(test)
      )
    ) {
      reject(
        `${id}: source-derived selection requires its reviewed sources, runtime imports and behavioral contracts; restore it or register fullTestReason for reclassification.`
      )
      continue
    }
    const original = baseManifest.modules[id]
    const owners = new Set(module.ownerPaths)
    for (const test of module.testFiles.consumer) {
      if (original?.testFiles.consumer.includes(test)) continue
      if (!inspect(test, owners).reachable)
        reject(
          `${id}: ${test} has no known dependency; register an explicit behavioral contract or runtime edge instead of inherited consumers.`
        )
    }
  }
  return violations
}

export function dependencyBasedConsumerRetirements(
  base,
  head,
  baseManifest,
  headManifest,
  { cwd = process.cwd() } = {}
) {
  try {
    // Cleanup must not change the code, contracts, platform routing or policy that authorizes it.
    const changed = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', base, head], {
      cwd,
      encoding: 'utf8'
    })
      .split('\0')
      .filter(Boolean)
    if (
      !changed.length ||
      changed.some(
        (path) => !/^scripts\/ci\/module-impact(?:\.json|\/[a-z][a-z0-9_]*\.json)$/.test(path)
      )
    )
      return new Set()
    if (
      Object.keys(baseManifest.modules).length !== Object.keys(headManifest.modules).length ||
      Object.entries(baseManifest.modules).some(([id, original]) => {
        const current = headManifest.modules[id]
        return (
          !current ||
          !isDeepStrictEqual(
            {
              ...original,
              testFiles: { ...original.testFiles, consumer: current.testFiles.consumer }
            },
            current
          ) ||
          current.testFiles.consumer.some((test) => !original.testFiles.consumer.includes(test))
        )
      })
    )
      return new Set()
    const sources = [sourceSnapshot(base, cwd), sourceSnapshot(head, cwd)]
    const edges = sources.flatMap((source) =>
      Object.entries(JSON.parse(source.read('scripts/ci/module-runtime-consumers.json') ?? '{}'))
    )
    const manifests = [baseManifest, headManifest]
    if (
      sources.some(
        (source, i) =>
          dependencyBoundaryViolations(source, manifests[i], manifests[i], edges).length
      )
    )
      return new Set()
    const inspectors = sources.map((source) => createConsumerDependencyReader(source, edges))
    const retired = new Set()
    for (const [id, original] of Object.entries(baseManifest.modules)) {
      const current = headManifest.modules[id]
      if (!usesDependencyConsumers(id, original) || !usesDependencyConsumers(id, current)) continue
      const owners = new Set(original.ownerPaths)
      for (const test of original.testFiles.consumer) {
        if (
          current.testFiles.consumer.includes(test) ||
          !sources.every((source) => source.read(test) !== undefined) ||
          inspectors.some((inspect) => inspect(test, owners).reachable)
        )
          continue
        retired.add(`${id}:${test}`)
      }
    }
    return retired
  } catch {
    return new Set()
  }
}
