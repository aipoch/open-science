import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  canHaveModifiers,
  createSourceFile,
  forEachChild,
  getModifiers,
  isCallExpression,
  isClassDeclaration,
  isConstructorDeclaration,
  isEnumDeclaration,
  isExportAssignment,
  isExportDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNamedExports,
  isNewExpression,
  isPropertyDeclaration,
  isPropertyAccessExpression,
  isReturnStatement,
  isVariableStatement,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type ClassDeclaration,
  type Node,
  type SourceFile
} from 'typescript'
import { describe, expect, it } from 'vitest'

const productionFiles = readdirSync(__dirname, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test-utils.ts')
  )
  .map((entry) => entry.name)
  .sort()
const sources = new Map(
  productionFiles.map((file) => [file, readFileSync(resolve(__dirname, file), 'utf8')])
)
const sourceFileFor = (file: string): SourceFile =>
  createSourceFile(file, sources.get(file)!, ScriptTarget.Latest, true, ScriptKind.TS)

const classFrom = (file: string, name: string): ClassDeclaration => {
  const candidate = sourceFileFor(file).statements.find(
    (statement) => isClassDeclaration(statement) && statement.name?.text === name
  )
  if (!candidate || !isClassDeclaration(candidate)) throw new Error(`${name} class not found`)
  return candidate
}

const hasModifier = (node: Node, kind: SyntaxKind): boolean =>
  canHaveModifiers(node) &&
  (getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)

const publicMethods = (declaration: ClassDeclaration): string[] =>
  declaration.members
    .filter(isMethodDeclaration)
    .filter(
      (member) =>
        !hasModifier(member, SyntaxKind.PrivateKeyword) &&
        !hasModifier(member, SyntaxKind.ProtectedKeyword)
    )
    .map((member) => (isIdentifier(member.name) ? member.name.text : undefined))
    .filter((name): name is string => name !== undefined)
    .sort()

const asyncMethods = (declaration: ClassDeclaration): string[] =>
  declaration.members
    .filter(isMethodDeclaration)
    .filter((member) => hasModifier(member, SyntaxKind.AsyncKeyword))
    .map((member) => (isIdentifier(member.name) ? member.name.text : undefined))
    .filter((name): name is string => name !== undefined)
    .sort()

const fields = (declaration: ClassDeclaration): string[] =>
  declaration.members
    .filter(isPropertyDeclaration)
    .map((member) => (isIdentifier(member.name) ? member.name.text : undefined))
    .filter((name): name is string => name !== undefined)
    .sort()

const newExpressionSites = (className: string): string[] => {
  const sites: string[] = []
  for (const file of productionFiles) {
    const sourceFile = sourceFileFor(file)
    const visit = (node: Node): void => {
      if (
        isNewExpression(node) &&
        isIdentifier(node.expression) &&
        node.expression.text === className
      ) {
        let current: Node | undefined = node.parent
        while (current && !isConstructorDeclaration(current)) current = current.parent
        sites.push(`${file}:${current ? 'constructor' : 'outside-constructor'}`)
      }
      forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return sites
}

const constructorParameters = (declaration: ClassDeclaration): string[] => {
  const constructors = declaration.members.filter(isConstructorDeclaration)
  expect(constructors).toHaveLength(1)
  return constructors[0].parameters.map((parameter) =>
    [
      parameter.name.getText(),
      parameter.type?.getText() ?? '<untyped>',
      parameter.initializer ? 'defaulted' : 'required'
    ].join(':')
  )
}

const methodDeclarationSites = (methodName: string): string[] => {
  const sites: string[] = []
  for (const file of productionFiles) {
    const sourceFile = sourceFileFor(file)
    for (const statement of sourceFile.statements) {
      if (!isClassDeclaration(statement) || !statement.name) continue
      for (const member of statement.members) {
        if (
          isMethodDeclaration(member) &&
          isIdentifier(member.name) &&
          member.name.text === methodName
        ) {
          sites.push(`${file}:${statement.name.text}`)
        }
      }
    }
  }
  return sites.sort()
}

const interactiveTransactionOptions = (): string[] => {
  const sites: string[] = []
  for (const file of productionFiles) {
    const sourceFile = sourceFileFor(file)
    const visit = (node: Node): void => {
      if (
        isCallExpression(node) &&
        isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === '$transaction'
      ) {
        sites.push(`${file}:${node.arguments[1]?.getText(sourceFile) ?? '<missing>'}`)
      }
      forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return sites.sort()
}

const functionCallSites = (functionName: string): string[] => {
  const sites: string[] = []
  for (const file of productionFiles) {
    const sourceFile = sourceFileFor(file)
    const visit = (node: Node): void => {
      if (isCallExpression(node) && isIdentifier(node.expression)) {
        if (node.expression.text === functionName) sites.push(file)
      }
      forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return sites.sort()
}

const variableInitializer = (file: string, variableName: string): string | undefined => {
  const sourceFile = sourceFileFor(file)
  for (const statement of sourceFile.statements) {
    if (!isVariableStatement(statement)) continue
    const declaration = statement.declarationList.declarations.find(
      (candidate) => isIdentifier(candidate.name) && candidate.name.text === variableName
    )
    if (declaration) return declaration.initializer?.getText(sourceFile)
  }
  return undefined
}

const facadeDelegations = (
  facade: ClassDeclaration,
  facadeFile: SourceFile
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    facade.members.filter(isMethodDeclaration).map((method) => {
      if (!isIdentifier(method.name) || !method.body || method.body.statements.length !== 1) {
        throw new Error('UploadRepository methods must be single-return delegations')
      }
      const [statement] = method.body.statements
      if (
        !isReturnStatement(statement) ||
        !statement.expression ||
        !isCallExpression(statement.expression) ||
        !isPropertyAccessExpression(statement.expression.expression)
      ) {
        throw new Error(`${method.name.text} is not a direct owner delegation`)
      }
      return [method.name.text, statement.expression.expression.getText(facadeFile)]
    })
  )

const exportedValues = (sourceFile: SourceFile): string[] => {
  const names: string[] = []
  for (const statement of sourceFile.statements) {
    if (isExportAssignment(statement)) {
      names.push(`default:${statement.expression.getText(sourceFile)}`)
      continue
    }
    if (isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue
      if (!statement.exportClause) {
        names.push('export-all')
      } else if (isNamedExports(statement.exportClause)) {
        names.push(
          ...statement.exportClause.elements
            .filter((element) => !element.isTypeOnly)
            .map((element) => element.name.text)
        )
      } else {
        names.push(`namespace:${statement.exportClause.getText(sourceFile)}`)
      }
      continue
    }
    if (!hasModifier(statement, SyntaxKind.ExportKeyword)) continue
    if (
      isClassDeclaration(statement) ||
      isFunctionDeclaration(statement) ||
      isEnumDeclaration(statement)
    ) {
      const name = statement.name?.text ?? '<anonymous-export>'
      names.push(hasModifier(statement, SyntaxKind.DefaultKeyword) ? `default:${name}` : name)
    } else if (isVariableStatement(statement)) {
      names.push(
        ...statement.declarationList.declarations.map((declaration) =>
          declaration.name.getText(sourceFile)
        )
      )
    }
  }
  return names.sort()
}

describe('Upload repository architecture', () => {
  const facadeFile = sourceFileFor('repository.ts')
  const facade = classFrom('repository.ts', 'UploadRepository')

  it('keeps every production module within the completion gate', () => {
    for (const [file, source] of sources) {
      const physicalLines = source.split(/\r?\n/).length - Number(source.endsWith('\n'))
      expect(physicalLines, file).toBeLessThanOrEqual(660)
    }
  })

  it('keeps the established 14-method public facade and three value exports', () => {
    const establishedMethods = [
      'abortTransfer',
      'appendTransfer',
      'beginTransfer',
      'deleteUpload',
      'finalizePendingSessionUploads',
      'finishTransfer',
      'getTransferStatus',
      'recoverStagingUploads',
      'resolveManagedUpload',
      'resolveManagedUploadPath',
      'resolveSessionUpload',
      'resolveSessionUploadPath',
      'stageLocalFile',
      'upgradeLegacySessionUploads'
    ].sort()
    expect(publicMethods(facade)).toEqual(establishedMethods)
    expect(asyncMethods(facade)).toEqual(establishedMethods)
    expect(constructorParameters(facade)).toEqual([
      'storageRoot:string:required',
      'options:UploadRepositoryOptions:defaulted'
    ])
    expect(exportedValues(facadeFile)).toEqual(
      [
        'OrphanLegacyUploadAuthorityMissingError',
        'UnsafeLegacyUploadResidualError',
        'UploadRepository'
      ].sort()
    )
  })

  it('distinguishes named, default, namespace and assignment value exports', () => {
    const alternateExports = createSourceFile(
      'alternate-exports.ts',
      [
        'export class Named {}',
        'export default function Defaulted() {}',
        "export * as scope from './scope'",
        'export const extra = 1'
      ].join('\n'),
      ScriptTarget.Latest,
      true,
      ScriptKind.TS
    )
    const assignmentExport = createSourceFile(
      'assignment-export.ts',
      'const assigned = 1; export default assigned',
      ScriptTarget.Latest,
      true,
      ScriptKind.TS
    )

    expect(exportedValues(alternateExports)).toEqual(
      ['Named', 'default:Defaulted', 'extra', 'namespace:* as scope'].sort()
    )
    expect(exportedValues(assignmentExport)).toEqual(['default:assigned'])
  })

  it('composes each owner exactly once without facade lifecycle state', () => {
    for (const owner of [
      'ActiveTransferOwner',
      'LegacyRecoveryOwner',
      'ManagedUploadResolver',
      'StagedPublicationOwner',
      'VerifiedLegacyCleanupOwner'
    ]) {
      expect(newExpressionSites(owner), owner).toEqual(['repository.ts:constructor'])
    }
    expect(fields(facade)).toEqual([
      'legacyRecoveryOwner',
      'managedUploadResolver',
      'stagedPublicationOwner',
      'transferOwner'
    ])
  })

  it('keeps every facade method as a direct delegation to its established owner', () => {
    expect(facadeDelegations(facade, facadeFile)).toEqual({
      abortTransfer: 'this.transferOwner.abortTransfer',
      appendTransfer: 'this.transferOwner.appendTransfer',
      beginTransfer: 'this.transferOwner.beginTransfer',
      deleteUpload: 'this.managedUploadResolver.deleteUpload',
      finalizePendingSessionUploads: 'this.stagedPublicationOwner.finalizePendingSessionUploads',
      finishTransfer: 'this.transferOwner.finishTransfer',
      getTransferStatus: 'this.transferOwner.getTransferStatus',
      recoverStagingUploads: 'this.legacyRecoveryOwner.recoverStagingUploads',
      resolveManagedUpload: 'this.managedUploadResolver.resolveManagedUpload',
      resolveManagedUploadPath: 'this.managedUploadResolver.resolveManagedUploadPath',
      resolveSessionUpload: 'this.managedUploadResolver.resolveSessionUpload',
      resolveSessionUploadPath: 'this.managedUploadResolver.resolveSessionUploadPath',
      stageLocalFile: 'this.transferOwner.stageLocalFile',
      upgradeLegacySessionUploads: 'this.legacyRecoveryOwner.upgradeLegacySessionUploads'
    })
  })

  it('keeps recovery and verified cleanup decisions behind their owners', () => {
    const facadeSource = sources.get('repository.ts')!
    const cleanupSource = sources.get('verified-legacy-cleanup-owner.ts')!
    const recoverySource = sources.get('legacy-recovery-owner.ts')!

    expect(facadeSource).not.toMatch(/from ['"]node:fs\/promises['"]/)
    expect(facadeSource).not.toContain('LEGACY_CLEANUP_PRIVATE_SUFFIX')
    expect(facadeSource).not.toContain('settleSiblingOperations')
    expect(publicMethods(classFrom('legacy-recovery-owner.ts', 'LegacyRecoveryOwner'))).toEqual(
      [
        'completeStagingUpload',
        'hasOrphanLegacyCandidate',
        'recoverStagingUploads',
        'removeVerifiedLegacyCopy',
        'upgradeLegacySessionUploads'
      ].sort()
    )
    expect(
      publicMethods(classFrom('verified-legacy-cleanup-owner.ts', 'VerifiedLegacyCleanupOwner'))
    ).toEqual(['assertLegacySourceAbsent', 'hasPrivateClaim', 'removeVerifiedLegacyCopy'].sort())
    expect(methodDeclarationSites('assertConsistentSessionUploadReferences')).toEqual([
      'legacy-recovery-owner.ts:LegacyRecoveryOwner'
    ])
    expect(methodDeclarationSites('hasOrphanLegacyCandidate')).toEqual([
      'legacy-recovery-owner.ts:LegacyRecoveryOwner'
    ])
    expect(methodDeclarationSites('completeStagingUpload')).toEqual([
      'legacy-recovery-owner.ts:LegacyRecoveryOwner'
    ])
    expect(methodDeclarationSites('restoreLegacyCleanupPrivate')).toEqual([
      'verified-legacy-cleanup-owner.ts:VerifiedLegacyCleanupOwner'
    ])
    expect(methodDeclarationSites('assertLegacySourceAbsent')).toEqual([
      'verified-legacy-cleanup-owner.ts:VerifiedLegacyCleanupOwner'
    ])
    expect(cleanupSource.match(/LEGACY_CLEANUP_PRIVATE_SUFFIX/g)).toHaveLength(4)
    for (const [file, source] of sources) {
      if (file !== 'verified-legacy-cleanup-owner.ts') {
        expect(source, file).not.toContain('LEGACY_CLEANUP_PRIVATE_SUFFIX')
      }
    }
    expect(recoverySource).toContain('cleanup: Pick<')
  })

  it('routes every interactive Upload transaction through the shared connection wait policy', () => {
    expect(variableInitializer('staged-publication-owner.ts', 'UPLOAD_TRANSACTION_OPTIONS')).toBe(
      '{ maxWait: 10_000 } as const'
    )
    expect(interactiveTransactionOptions()).toEqual([
      'staged-publication-owner.ts:UPLOAD_TRANSACTION_OPTIONS'
    ])
    expect(functionCallSites('runUploadTransaction')).toEqual([
      'legacy-recovery-owner.ts',
      'legacy-recovery-owner.ts',
      'staged-publication-owner.ts'
    ])
  })
})
