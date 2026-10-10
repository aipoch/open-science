import { loadModuleImpactManifest } from '../../../scripts/ci/load-module-impact.mjs'
import { dirname, relative, resolve, sep } from 'node:path'
import {
  createSourceFile,
  isExportDeclaration,
  isImportDeclaration,
  isStringLiteral,
  preProcessFile,
  resolveModuleName,
  ModuleResolutionKind,
  sys,
  ScriptTarget
} from 'typescript'
import { expect, it } from 'vitest'
import {
  listProductionSources,
  readProductionSource
} from '../../../test/architecture-source-index'

it('keeps Custom MCP implementation imports behind its facade and pure URL admission entry', () => {
  const root = resolve(__dirname, '../../..')
  const moduleRoot = resolve(__dirname, 'custom-mcp')
  const violations: string[] = []
  for (const file of listProductionSources(root)) {
    if (file.startsWith(moduleRoot + sep)) continue
    const source = readProductionSource(file, root)
    if (!source.includes('custom-mcp/')) continue
    const parsed = createSourceFile(file, source, ScriptTarget.Latest)
    for (const statement of parsed.statements) {
      if (!(isImportDeclaration(statement) || isExportDeclaration(statement))) continue
      const specifier = statement.moduleSpecifier
      if (!specifier || !isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue
      const target = resolve(dirname(file), specifier.text)
      if (
        target.startsWith(moduleRoot + sep) &&
        !/^(?:index|url)(?:\.ts)?$/.test(relative(moduleRoot, target))
      ) {
        violations.push(`${relative(root, file)} -> ${specifier.text}`)
      }
    }
  }
  expect(violations).toEqual([])
})

it('keeps descriptor families independent of host integration and connector-core independent of both', () => {
  const root = resolve(__dirname, '../../..')
  const { modules } = loadModuleImpactManifest(resolve(root, 'scripts/ci/module-impact.json'))
  const owners = new Map<string, string>()
  for (const [owner, module] of Object.entries(modules)) {
    for (const path of (module as { ownerPaths: string[] }).ownerPaths) {
      owners.set(resolve(root, path), owner)
    }
  }
  const violations: string[] = []
  for (const file of listProductionSources(root)) {
    const owner = owners.get(file)
    if (!owner?.startsWith('connector_')) continue
    const source = readProductionSource(file, root)
    for (const { fileName: specifier } of preProcessFile(source, true, true).importedFiles) {
      const target = resolveModuleName(
        specifier,
        file,
        {
          moduleResolution: ModuleResolutionKind.Bundler
        },
        sys
      ).resolvedModule?.resolvedFileName
      if (!target) continue
      const targetOwner = owners.get(target)
      if (
        targetOwner === 'main_connectors' ||
        (owner === 'connector_core' && targetOwner && targetOwner !== 'connector_core')
      ) {
        violations.push(`${relative(root, file)} -> ${specifier} (${targetOwner})`)
      }
    }
  }
  expect(violations).toEqual([])
})
