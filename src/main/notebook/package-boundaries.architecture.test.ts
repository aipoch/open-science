import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import {
  createModuleResolutionCache,
  preProcessFile,
  readConfigFile,
  parseJsonConfigFileContent,
  resolveModuleName,
  ModuleResolutionKind,
  sys,
  createSourceFile,
  isExportDeclaration,
  isImportDeclaration,
  isNamedImports,
  isNamedExports,
  ScriptTarget
} from 'typescript'
import { expect, it } from 'vitest'

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
  const packages = ['notebook-syntax', 'notebook-code-risk', 'notebook-analysis'].map((name) => {
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
    const syntax = createSourceFile(path, source, ScriptTarget.Latest, false)
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
    for (const { fileName: specifier } of preProcessFile(source, true, true).importedFiles) {
      const target = resolutionOptions
        .map(
          (options, index) =>
            resolveModuleName(specifier, file, options, sys, resolutionCaches[index]).resolvedModule
              ?.resolvedFileName
        )
        .find(Boolean)
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
})
