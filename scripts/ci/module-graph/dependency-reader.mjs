/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { posix, resolve } from 'node:path'
import ts from 'typescript'
import { localPackageSourcePaths } from '../local-package-exports.mjs'
import { isSourcePath } from './source.mjs'

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

export function createDependencyReader(
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
    if (!isSourcePath(path)) {
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
