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
  sys
} from 'typescript'
import { expect, it } from 'vitest'

// Keep the full-tree parser under V8 coverage; it can exceed the CI default of 30s.
it('consumes Connector packages only through exports and keeps packages independent of host source', () => {
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
  const packages = ['connector-core', 'connector-builtins', 'connector-mcp-client'].map((name) => {
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
  // Only provider distributions and MCP may depend on core; neither may depend on the other.
  for (const owner of packages) {
    const declared = { ...owner.manifest.dependencies, ...owner.manifest.peerDependencies }
    for (const dependency of packages) {
      if (dependency.manifest.name in declared) {
        expect(owner.manifest.name).not.toBe('@aipoch/connector-core')
        expect(dependency.manifest.name).toBe('@aipoch/connector-core')
      }
    }
  }
  expect([...packages[0].entries]).toEqual([
    '@aipoch/connector-core',
    '@aipoch/connector-core/url-admission'
  ])
  expect(packages[1].entries.has('@aipoch/connector-builtins')).toBe(false)
  expect([...packages[2].entries]).toEqual([
    '@aipoch/connector-mcp-client',
    '@aipoch/connector-mcp-client/oauth-redirect'
  ])
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
    for (const { fileName: specifier } of preProcessFile(source, true, true).importedFiles) {
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
          ...(!path.includes('/src/') || /(?:\.test\.[cm]?[jt]sx?$|\/test-helpers\/)/.test(path)
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
