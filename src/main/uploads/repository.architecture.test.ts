import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  canHaveModifiers,
  createSourceFile,
  forEachChild,
  getModifiers,
  isArrowFunction,
  isCallExpression,
  isClassDeclaration,
  isConstructorDeclaration,
  isEnumDeclaration,
  isExportAssignment,
  isExportDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isNamedExports,
  isNewExpression,
  isPropertyDeclaration,
  isPropertyAccessExpression,
  isSourceFile,
  isVariableStatement,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
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

const hasModifier = (node: Node, kind: SyntaxKind): boolean =>
  canHaveModifiers(node) &&
  (getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)

const hasFacadeLifetime = (expression: Node): boolean => {
  let current: Node | undefined = expression.parent
  while (current) {
    if (isConstructorDeclaration(current) || isPropertyDeclaration(current)) {
      const facade = current.parent
      const isTargetFacade =
        isClassDeclaration(facade) &&
        facade.name?.text === 'UploadRepository' &&
        isSourceFile(facade.parent)
      const isStaticField =
        isPropertyDeclaration(current) && hasModifier(current, SyntaxKind.StaticKeyword)
      return isTargetFacade && !isStaticField
    }
    if (
      isMethodDeclaration(current) ||
      isFunctionDeclaration(current) ||
      isFunctionExpression(current) ||
      isArrowFunction(current)
    ) {
      return false
    }
    current = current.parent
  }
  return false
}

const newExpressionLifetimes = (
  sourceFile: SourceFile,
  className: string
): Array<'class' | 'transient'> => {
  const lifetimes: Array<'class' | 'transient'> = []
  const visit = (node: Node): void => {
    if (
      isNewExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === className
    ) {
      lifetimes.push(hasFacadeLifetime(node) ? 'class' : 'transient')
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)
  return lifetimes
}

const newExpressionFiles = (
  className: string,
  lifetime: 'class' | 'transient' = 'class'
): string[] => {
  const sites: string[] = []
  for (const file of productionFiles) {
    const sourceFile = sourceFileFor(file)
    for (const siteLifetime of newExpressionLifetimes(sourceFile, className)) {
      if (siteLifetime === lifetime) sites.push(file)
    }
  }
  return sites
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

  it('keeps the public value exports stable', () => {
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

  it('composes each owner exactly once behind the facade', () => {
    for (const owner of [
      'ActiveTransferOwner',
      'LegacyRecoveryOwner',
      'ManagedUploadResolver',
      'StagedPublicationOwner',
      'VerifiedLegacyCleanupOwner'
    ]) {
      expect(newExpressionFiles(owner), owner).toEqual(['repository.ts'])
      expect(newExpressionFiles(owner, 'transient'), owner).toEqual([])
    }

    const fieldInitializerFile = createSourceFile(
      'field-initializer.ts',
      'class UploadRepository { private readonly owner = new ActiveTransferOwner() }',
      ScriptTarget.Latest,
      true,
      ScriptKind.TS
    )
    expect(newExpressionLifetimes(fieldInitializerFile, 'ActiveTransferOwner')).toEqual(['class'])

    const methodConstructionFile = createSourceFile(
      'method-construction.ts',
      'class UploadRepository { createOwner() { return new ActiveTransferOwner() } }',
      ScriptTarget.Latest,
      true,
      ScriptKind.TS
    )
    expect(newExpressionLifetimes(methodConstructionFile, 'ActiveTransferOwner')).toEqual([
      'transient'
    ])

    const staticFieldFile = createSourceFile(
      'static-field.ts',
      'class UploadRepository { static owner = new ActiveTransferOwner() }',
      ScriptTarget.Latest,
      true,
      ScriptKind.TS
    )
    expect(newExpressionLifetimes(staticFieldFile, 'ActiveTransferOwner')).toEqual(['transient'])

    const nestedClassFile = createSourceFile(
      'nested-class.ts',
      'class UploadRepository { createOwner() { class Holder { owner = new ActiveTransferOwner() } return Holder } }',
      ScriptTarget.Latest,
      true,
      ScriptKind.TS
    )
    expect(newExpressionLifetimes(nestedClassFile, 'ActiveTransferOwner')).toEqual(['transient'])
  })

  it('keeps recovery and verified cleanup decisions behind their owners', () => {
    const facadeSource = sources.get('repository.ts')!

    expect(facadeSource).not.toMatch(/from ['"]node:fs\/promises['"]/)
    expect(facadeSource).not.toContain('LEGACY_CLEANUP_PRIVATE_SUFFIX')
    expect(facadeSource).not.toContain('settleSiblingOperations')
    for (const [file, source] of sources) {
      if (file !== 'verified-legacy-cleanup-owner.ts') {
        expect(source, file).not.toContain('LEGACY_CLEANUP_PRIVATE_SUFFIX')
      }
    }
  })

  it('routes every interactive Upload transaction through the shared connection wait policy', () => {
    expect(variableInitializer('staged-publication-owner.ts', 'UPLOAD_TRANSACTION_OPTIONS')).toBe(
      '{ maxWait: 10_000 } as const'
    )
    const transactionOptions = interactiveTransactionOptions()
    expect(transactionOptions.length).toBeGreaterThan(0)
    for (const site of transactionOptions) expect(site).toMatch(/:UPLOAD_TRANSACTION_OPTIONS$/)

    expect([...new Set(functionCallSites('runUploadTransaction'))]).toEqual([
      'legacy-recovery-owner.ts',
      'staged-publication-owner.ts'
    ])
  })
})
