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

import {
  listProductionSources,
  readProductionSource
} from '../../../test/architecture-source-index'

const projectRoot = resolve(__dirname, '../../..')
const ownerPath = resolve(__dirname, 'provider-auth-lifecycle.ts')
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
  let imports = false
  const sourceFile = sourceFileFor(path)
  const visit = (node: Node): void => {
    if (
      isImportDeclaration(node) &&
      node.moduleSpecifier.getText(sourceFile).includes('provider-auth-lifecycle')
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
      isClassDeclaration(statement) && statement.name?.text === 'ProviderAuthLifecycleOwner'
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

describe('Provider authentication lifecycle ownership', () => {
  it('keeps authentication behind the provider owner boundary', () => {
    const source = readSource(ownerPath)
    expect(source).not.toMatch(/ipcMain|contextBridge|window\.api/)
    expect(source).toContain('keyRef: encryptKey(token)')
    expect(source).not.toMatch(/keyRef:\s*token\b/)
  })

  it('locks the owner interface and compatibility exports', () => {
    expect(publicOperations()).toEqual([
      'cancelClaudeIsolatedLogin',
      'cancelClaudeLogin',
      'cancelCodexLogin',
      'cleanupProviderBeforeDelete',
      'dispose',
      'getClaudeIsolatedStatus',
      'getClaudeSharedStatus',
      'isProviderKeyUsable',
      'loginClaudeShared',
      'loginIsolatedClaude',
      'loginIsolatedClaudeBrowser',
      'loginIsolatedCodex',
      'logoutClaudeShared',
      'logoutIsolatedClaude',
      'logoutIsolatedCodex',
      'prepareCodexProviderUpsert',
      'serializeAccountMutation',
      'validateProviderAuth'
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
      'value:CLAUDE_SHARED_DISCONNECTED_MESSAGE',
      'value:ProviderAuthLifecycleOwner',
      'type:ProviderAuthLifecycleOwnerOptions'
    ])
  })

  it('keeps the internal owner behind ProviderAccountsModule and in its impact set', () => {
    expect(productionSources().filter(importsOwner).map(portablePath)).toEqual([
      'src/main/settings/provider-accounts.ts'
    ])
    const manifest = JSON.parse(readSource(manifestPath)) as {
      modules: Record<string, { ownerPaths: string[]; testFiles: { owner: string[] } }>
    }
    expect(manifest.modules.settings_provider_accounts.ownerPaths).toContain(
      'src/main/settings/provider-auth-lifecycle.ts'
    )
    expect(manifest.modules.settings_provider_accounts.testFiles.owner).toEqual(
      expect.arrayContaining([
        'src/main/settings/provider-auth-lifecycle.test.ts',
        'src/main/settings/provider-auth-lifecycle.architecture.test.ts'
      ])
    )
  })
})
