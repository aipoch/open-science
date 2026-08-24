import { readFileSync, readdirSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'

import {
  canHaveModifiers,
  createSourceFile,
  getModifiers,
  isClassDeclaration,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isMethodDeclaration,
  isNamedExports,
  isPropertyDeclaration,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type Node,
  type SourceFile
} from 'typescript'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(__dirname, '../../..')
const ownerPath = resolve(__dirname, 'provider-runtime-projection.ts')
const manifestPath = resolve(projectRoot, 'scripts/ci/module-impact.json')
const readSource = (path: string): string => readFileSync(path, 'utf8')
const sourceFileFor = (path: string): SourceFile =>
  createSourceFile(
    path,
    readSource(path),
    ScriptTarget.Latest,
    true,
    extname(path) === '.tsx' ? ScriptKind.TSX : ScriptKind.TS
  )
const portablePath = (path: string): string => relative(projectRoot, path).replaceAll('\\', '/')

const productionSources = (): string[] => {
  const sources: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (
        ['.ts', '.tsx'].includes(extname(path)) &&
        !/\.(?:test|spec)\.[cm]?tsx?$/.test(entry.name)
      ) {
        sources.push(path)
      }
    }
  }
  visit(resolve(projectRoot, 'src'))
  visit(resolve(projectRoot, 'packages'))
  return sources
}

const importsOwner = (path: string): boolean => {
  let imports = false
  const sourceFile = sourceFileFor(path)
  const visit = (node: Node): void => {
    if (
      isImportDeclaration(node) &&
      node.moduleSpecifier.getText(sourceFile).includes('provider-runtime-projection')
    ) {
      imports = true
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return imports
}

const publicOperations = (): string[] => {
  const declaration = sourceFileFor(ownerPath).statements.find(
    (statement) =>
      isClassDeclaration(statement) && statement.name?.text === 'ProviderRuntimeProjectionOwner'
  )
  if (!declaration || !isClassDeclaration(declaration)) throw new Error('owner class not found')
  return declaration.members
    .flatMap((member) => {
      const hidden =
        canHaveModifiers(member) &&
        getModifiers(member)?.some((modifier) => modifier.kind === SyntaxKind.PrivateKeyword)
      return !hidden &&
        (isMethodDeclaration(member) || isPropertyDeclaration(member)) &&
        isIdentifier(member.name)
        ? [member.name.text]
        : []
    })
    .sort()
}

describe('Provider runtime projection ownership', () => {
  it('keeps one focused owner below the production hard limit', () => {
    const source = readSource(ownerPath)
    expect(source.split(/\r?\n/).length - Number(source.endsWith('\n'))).toBeLessThanOrEqual(660)
    expect(source).not.toMatch(/SettingsRepository|setActiveProvider|upsertProvider/)
  })

  it('locks the owner interface and compatibility exports', () => {
    expect(publicOperations()).toEqual([
      'resolveActiveModel',
      'resolveProvider',
      'resolveProviderApiEndpoints',
      'resolveRuntimeModelCatalog',
      'resolveRuntimeReasoningEffortProfile',
      'resolveRuntimeTarget',
      'toProviderView'
    ])

    const exportDeclaration = sourceFileFor(ownerPath).statements.filter(isExportDeclaration)
    expect(
      exportDeclaration.flatMap((statement) =>
        statement.exportClause && isNamedExports(statement.exportClause)
          ? statement.exportClause.elements.map(
              (element) =>
                `${statement.isTypeOnly || element.isTypeOnly ? 'type' : 'value'}:${element.name.text}`
            )
          : []
      )
    ).toEqual([
      'value:ProviderRuntimeProjectionOwner',
      'value:requiresNativeResponsesCompatibility',
      'type:ProviderRuntimeTarget',
      'type:RuntimeProviderModelSelection'
    ])
  })

  it('keeps the internal owner behind ProviderAccountsModule and in its impact set', () => {
    expect(productionSources().filter(importsOwner).map(portablePath)).toEqual([
      'src/main/settings/provider-accounts.ts'
    ])
    const manifest = JSON.parse(readSource(manifestPath)) as {
      modules: Record<string, { ownerPaths: string[]; testFiles: { owner: string[] } }>
    }
    expect(manifest.modules.settings_provider_accounts.ownerPaths).toEqual([
      'src/main/settings/provider-accounts.ts',
      'src/main/settings/provider-auth-lifecycle.ts',
      'src/main/settings/provider-draft-projection.ts',
      'src/main/settings/provider-model-catalog-owner.ts',
      'src/main/settings/provider-runtime-projection.ts',
      'src/main/settings/xai-oauth.ts',
      'src/main/settings/xai-provider-account-owner.ts'
    ])
    expect(manifest.modules.settings_provider_accounts.testFiles.owner).toEqual(
      expect.arrayContaining([
        'src/main/settings/provider-runtime-projection.test.ts',
        'src/main/settings/provider-runtime-projection.architecture.test.ts'
      ])
    )
  })
})
