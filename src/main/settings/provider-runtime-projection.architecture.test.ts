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

import { loadModuleImpactManifest } from '../../../scripts/ci/load-module-impact.mjs'

import {
  listProductionSources,
  readProductionSource
} from '../../../test/architecture-source-index'

const projectRoot = resolve(__dirname, '../../..')
const ownerPath = resolve(__dirname, 'provider-runtime-projection.ts')
const manifestPath = resolve(projectRoot, 'scripts/ci/module-impact.json')
const readSource = (path: string): string => readProductionSource(path, projectRoot)
const sourceFileFor = (path: string): SourceFile =>
  createSourceFile(
    path,
    readSource(path),
    ScriptTarget.Latest,
    true,
    extname(path) === '.tsx' ? ScriptKind.TSX : ScriptKind.TS
  )
const portablePath = (path: string): string => relative(projectRoot, path).replaceAll('\\', '/')

const productionSources = (): readonly string[] => listProductionSources(projectRoot)

const importsOwner = (path: string): boolean => {
  // The AST predicate below requires this literal module name; skip unrelated files before parsing.
  if (!readSource(path).includes('provider-runtime-projection')) return false
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
  it('keeps persistence out of the runtime projection owner', () => {
    const source = readSource(ownerPath)
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
    const manifest = loadModuleImpactManifest(manifestPath)
    expect(manifest.modules.settings_provider_accounts.ownerPaths).toEqual([
      'src/main/settings/bounded-response.ts',
      'src/main/settings/provider-accounts.ts',
      'src/main/settings/provider-auth-lifecycle.ts',
      'src/main/settings/provider-draft-projection.ts',
      'src/main/settings/provider-model-catalog-owner.ts',
      'src/main/settings/provider-resource-limits.ts',
      'src/main/settings/provider-runtime-projection.ts',
      'src/main/settings/xai-oauth.ts',
      'src/main/settings/xai-provider-account-owner.ts',
      'src/main/settings/claude-isolated-auth.test.ts',
      'src/main/settings/claude-isolated-auth.ts',
      'src/main/settings/claude-shared-auth.test.ts',
      'src/main/settings/claude-shared-auth.ts',
      'src/main/settings/codex-auth.test.ts',
      'src/main/settings/codex-auth.ts',
      'src/main/settings/crypto.test.ts',
      'src/main/settings/crypto.ts',
      'src/main/settings/list-models.test.ts',
      'src/main/settings/list-models.ts',
      'src/main/settings/provider-accounts.test.ts',
      'src/main/settings/provider-auth-lifecycle.architecture.test.ts',
      'src/main/settings/provider-auth-lifecycle.test.ts',
      'src/main/settings/provider-env.test.ts',
      'src/main/settings/provider-env.ts',
      'src/main/settings/provider-runtime-projection.architecture.test.ts',
      'src/main/settings/provider-runtime-projection.test.ts',
      'src/main/settings/validate.test.ts',
      'src/main/settings/validate.ts',
      'src/main/settings/xai-oauth.test.ts',
      'src/main/settings/xai-provider-account-owner.test.ts'
    ])
    expect(manifest.modules.settings_provider_accounts.testFiles.owner).toEqual([
      'src/main/settings/settings-backend.architecture.test.ts',
      'src/main/settings/provider-accounts.test.ts',
      'src/main/settings/provider-auth-lifecycle.test.ts',
      'src/main/settings/provider-auth-lifecycle.architecture.test.ts',
      'src/main/settings/provider-runtime-projection.test.ts',
      'src/main/settings/provider-runtime-projection.architecture.test.ts',
      'src/main/settings/xai-oauth.test.ts',
      'src/main/settings/xai-provider-account-owner.test.ts',
      'src/main/settings/codex-auth.test.ts',
      'src/main/settings/claude-isolated-auth.test.ts',
      'src/main/settings/claude-shared-auth.test.ts',
      'src/main/settings/validate.test.ts',
      'src/main/settings/list-models.test.ts',
      'src/main/settings/crypto.test.ts',
      'src/main/settings/provider-env.test.ts'
    ])
  })
})
