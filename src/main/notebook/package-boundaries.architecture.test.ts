import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import ts, {
  createModuleResolutionCache,
  createSourceFile,
  isExportDeclaration,
  isImportDeclaration,
  isNamedExports,
  isNamedImports,
  ModuleResolutionKind,
  parseJsonConfigFileContent,
  preProcessFile,
  readConfigFile,
  resolveModuleName,
  ScriptTarget,
  sys
} from 'typescript'
import { expect, it } from 'vitest'

it('reads helper evidence identity through the lightweight package entry', () => {
  const imports = preProcessFile(
    readFileSync(resolve(__dirname, 'helper-evidence.ts'), 'utf8'),
    true,
    true
  ).importedFiles.map(({ fileName }) => fileName)
  expect(imports).toContain('@aipoch/reproducibility/helper-identity')
  expect(imports).not.toContain('@aipoch/reproducibility')
})

it('consumes Notebook packages only through exports and keeps packages independent of host source', () => {
  const root = resolve(__dirname, '../../..')
  const resolutionOptions = ['tsconfig.node.json', 'tsconfig.web.json'].map((name) => ({
    ...parseJsonConfigFileContent(
      readConfigFile(resolve(root, name), sys.readFile).config,
      sys,
      root
    ).options,
    moduleResolution: ModuleResolutionKind.Bundler
  }))
  const resolutionCaches = resolutionOptions.map((options) =>
    createModuleResolutionCache(root, (path) => path, options)
  )
  const packages = [
    'notebook-syntax',
    'notebook-code-risk',
    'notebook-analysis',
    'environment'
  ].map((name) => {
    const directory = resolve(root, 'packages', name)
    const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
    return {
      directory,
      manifest,
      entries: new Set(
        Object.keys(manifest.exports).map((entry) =>
          entry === '.' ? manifest.name : `${manifest.name}/${entry.slice(2)}`
        )
      )
    }
  })
  // Syntax is the sole shared upstream; risk and lineage have no dependency on each other.
  for (const owner of packages) {
    for (const dependency of packages) {
      if (dependency.manifest.name in (owner.manifest.dependencies ?? {})) {
        expect(owner.manifest.name).not.toBe('@aipoch/notebook-syntax')
        expect(dependency.manifest.name).toBe('@aipoch/notebook-syntax')
      }
    }
  }
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' }
  )
    .split('\0')
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file) && existsSync(resolve(root, file)))
  const violations: string[] = []
  for (const path of files) {
    const file = resolve(root, path)
    const owner = packages.find((pkg) => file.startsWith(pkg.directory + sep))
    const source = readFileSync(file, 'utf8')
    const imports = preProcessFile(source, true, true).importedFiles
    // Import resolution below still checks every file. Only package sources and host
    // files naming a public package can contain the forwarding/export cases needing an AST.
    const syntax = createSourceFile(
      path,
      owner ||
        imports.some(({ fileName }) =>
          packages.some(
            (pkg) => fileName === pkg.manifest.name || fileName.startsWith(pkg.manifest.name + '/')
          )
        )
        ? source
        : '',
      ScriptTarget.Latest,
      false
    )
    const packageBindings = new Set<string>()
    for (const statement of syntax.statements) {
      if (!isImportDeclaration(statement) || !statement.importClause) continue
      const specifier = statement.moduleSpecifier.getText(syntax).slice(1, -1)
      if (
        !packages.some(
          (pkg) => specifier === pkg.manifest.name || specifier.startsWith(pkg.manifest.name + '/')
        )
      )
        continue
      if (statement.importClause.name) packageBindings.add(statement.importClause.name.text)
      const bindings = statement.importClause.namedBindings
      if (bindings && isNamedImports(bindings))
        for (const binding of bindings.elements) packageBindings.add(binding.name.text)
      else if (bindings) packageBindings.add(bindings.name.text)
    }
    for (const statement of syntax.statements) {
      if (!isExportDeclaration(statement)) continue
      if (
        !owner &&
        !statement.moduleSpecifier &&
        statement.exportClause &&
        isNamedExports(statement.exportClause)
      ) {
        for (const binding of statement.exportClause.elements)
          if (packageBindings.has((binding.propertyName ?? binding.name).text))
            violations.push(
              `${path} -> host forwarding export ${binding.name.text}; import the package directly`
            )
      }
      if (owner && !statement.exportClause)
        violations.push(`${path} -> wildcard export expands the package API implicitly`)
      if (
        !owner &&
        statement.moduleSpecifier &&
        packages.some((pkg) =>
          statement.moduleSpecifier!.getText(syntax).slice(1, -1).startsWith(pkg.manifest.name)
        )
      )
        violations.push(`${path} -> host forwarding export; import the public package directly`)
    }
    for (const { fileName: specifier } of imports) {
      if (specifier.startsWith('node:')) continue
      let target: string | undefined
      for (const [index, options] of resolutionOptions.entries()) {
        target = resolveModuleName(specifier, file, options, sys, resolutionCaches[index])
          .resolvedModule?.resolvedFileName
        if (target) break
      }
      for (const pkg of packages) {
        if (specifier === pkg.manifest.name || specifier.startsWith(pkg.manifest.name + '/')) {
          if (!pkg.entries.has(specifier)) violations.push(`${path} -> private export ${specifier}`)
        } else if (target?.startsWith(pkg.directory + sep) && owner !== pkg) {
          violations.push(`${path} -> package source ${specifier}`)
        }
      }
      if (!owner) continue
      if (specifier.startsWith('.')) {
        if (!resolve(dirname(file), specifier).startsWith(owner.directory + sep)) {
          violations.push(`${path} -> outside package ${specifier}`)
        }
      } else if (!specifier.startsWith('node:')) {
        const dependency = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0]
        const declared = {
          ...owner.manifest.dependencies,
          ...owner.manifest.peerDependencies,
          ...(!path.includes('/src/') ||
          /(?:\.test\.[cm]?[jt]sx?$|-test-support\.ts$|\/test-helpers\/)/.test(path)
            ? owner.manifest.devDependencies
            : {})
        }
        if (!(dependency in declared))
          violations.push(`${path} -> undeclared dependency ${specifier}`)
      }
    }
  }
  expect(violations).toEqual([])
}, 60_000)

it('keeps every host analysis and admission case connected to host behavior', () => {
  // A file-level import check misses pure package cases mixed into an integration suite.
  // Follow local helpers from each case, excluding fixtures, types and host test setup.
  const paths = readdirSync(__dirname)
    .filter(
      (name) =>
        [
          'artifact-analysis-contract.integration.test.ts',
          'artifact-r-reproduction.integration.test.ts',
          'kernel-lineage-recovery.integration.test.ts',
          'kernel-file-evidence.integration.test.ts',
          'working-file-observer.analysis-contract.integration.test.ts',
          'working-file-observer.write-scope.integration.test.ts'
        ].includes(name) ||
        /^dependency-analysis\..*\.test\.ts$/.test(name) ||
        name === 'code-risk-admission.test.ts'
    )
    .map((name) => resolve(__dirname, name))
  const program = ts.createProgram(paths, { noResolve: true, noLib: true })
  const checker = program.getTypeChecker()
  const violations: string[] = []
  const callRoot = (node: ts.Node): string =>
    ts.isCallExpression(node)
      ? callRoot(node.expression)
      : ts.isPropertyAccessExpression(node)
        ? callRoot(node.expression)
        : ts.isIdentifier(node)
          ? node.text
          : ''

  for (const path of paths) {
    const source = program.getSourceFile(path)!
    if (
      path.endsWith('working-file-observer.analysis-contract.integration.test.ts') ||
      path.endsWith('kernel-file-evidence.integration.test.ts')
    ) {
      expect(source.text).not.toMatch(/reported-|fixture|readFileSync/)
    }
    const usesHost = (test: ts.Node): boolean => {
      const visited = new Set<ts.Node>()
      const visit = (node: ts.Node): boolean => {
        if (visited.has(node) || ts.isTypeNode(node)) return false
        visited.add(node)
        if (ts.isIdentifier(node)) {
          for (const declaration of checker.getSymbolAtLocation(node)?.declarations ?? []) {
            if (declaration.getSourceFile() !== source) continue
            if (ts.isImportSpecifier(declaration) || ts.isNamespaceImport(declaration)) {
              let parent: ts.Node = declaration
              while (!ts.isImportDeclaration(parent)) parent = parent.parent
              const specifier = (parent.moduleSpecifier as ts.StringLiteral).text
              if (
                !parent.importClause?.isTypeOnly &&
                !(ts.isImportSpecifier(declaration) && declaration.isTypeOnly) &&
                specifier.startsWith('./') &&
                !specifier.includes('fixture') &&
                !specifier.includes('test-support') &&
                specifier !== './dependency-analysis-adapter' &&
                existsSync(resolve(__dirname, `${specifier}.ts`))
              )
                return true
            } else if (ts.isBindingElement(declaration)) {
              let parent: ts.Node = declaration
              while (ts.isBindingElement(parent) || ts.isObjectBindingPattern(parent))
                parent = parent.parent
              if (
                ts.isVariableDeclaration(parent) &&
                parent.initializer &&
                visit(parent.initializer)
              )
                return true
            } else if (ts.isVariableDeclaration(declaration)) {
              if (declaration.initializer && visit(declaration.initializer)) return true
            } else if (ts.isFunctionDeclaration(declaration) && declaration.body) {
              if (visit(declaration.body)) return true
            }
          }
        }
        return ts.forEachChild(node, (child) => (visit(child) ? true : undefined)) === true
      }
      return visit(test)
    }
    const inspect = (node: ts.Node): void => {
      if (
        ts.isExpressionStatement(node) &&
        ts.isCallExpression(node.expression) &&
        ['it', 'test'].includes(callRoot(node.expression))
      ) {
        if (!usesHost(node)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
          violations.push(
            `${path}:${line} has no host behavior beyond analyzer construction; move algorithm assertions into the package`
          )
        }
        return
      }
      ts.forEachChild(node, inspect)
    }
    inspect(source)
  }
  expect(violations).toEqual([])
}, 30_000)
