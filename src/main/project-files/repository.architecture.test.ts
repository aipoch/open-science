import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  createSourceFile,
  forEachChild,
  isArrowFunction,
  isClassDeclaration,
  isConstructorDeclaration,
  isExportDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isNamedExports,
  isNewExpression,
  isPropertyDeclaration,
  isSourceFile,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type Node,
  type SourceFile
} from 'typescript'
import { describe, expect, it } from 'vitest'

const productionFiles = [
  'mutation-owner.ts',
  'mutation-projection.ts',
  'query-owner.ts',
  'query-support.ts',
  'repository.ts'
] as const
const sources = new Map(
  productionFiles.map((file) => [file, readFileSync(resolve(__dirname, file), 'utf8')])
)
const sourceFileFor = (file: (typeof productionFiles)[number]): SourceFile =>
  createSourceFile(file, sources.get(file)!, ScriptTarget.Latest, true, ScriptKind.TS)

const hasFacadeLifetime = (expression: Node): boolean => {
  let current: Node | undefined = expression.parent
  while (current) {
    if (isConstructorDeclaration(current) || isPropertyDeclaration(current)) {
      const facade = current.parent
      const isTargetFacade =
        isClassDeclaration(facade) &&
        facade.name?.text === 'ManagedFileIndexRepository' &&
        isSourceFile(facade.parent)
      const isStaticField =
        isPropertyDeclaration(current) &&
        current.modifiers?.some((modifier) => modifier.kind === SyntaxKind.StaticKeyword)
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

const newExpressionCount = (
  sourceFile: SourceFile,
  className: string,
  lifetime: 'class' | 'transient' = 'class'
): number => {
  let count = 0
  const visit = (node: Node): void => {
    if (
      isNewExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === className &&
      (hasFacadeLifetime(node) ? 'class' : 'transient') === lifetime
    ) {
      count += 1
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)
  return count
}

const namedExports = (sourceFile: SourceFile): string[] =>
  sourceFile.statements
    .filter(isExportDeclaration)
    .flatMap((statement) =>
      statement.exportClause && isNamedExports(statement.exportClause)
        ? statement.exportClause.elements.map(
            (element) => `${statement.isTypeOnly ? 'type' : 'value'}:${element.name.text}`
          )
        : []
    )
    .sort()

describe('Project Files repository architecture', () => {
  const facadeFile = sourceFileFor('repository.ts')

  it('keeps the public repository exports stable', () => {
    expect(namedExports(facadeFile)).toEqual(
      [
        'value:createManagedFileIndexRepository',
        'value:ManagedFileIndexRepository',
        'value:ProjectFilesReconciliationError',
        'type:LegacyArtifactVersionAdopter',
        'type:LegacyUploadVersionUpgrader',
        'type:ManagedFileSoftDeleteToken',
        'type:ProjectFilesClient',
        'type:ProjectFilesClientFactory',
        'type:ProjectFilesClientProvider'
      ].sort()
    )
  })

  it('composes one mutation owner and one query owner regardless of construction syntax', () => {
    expect(newExpressionCount(facadeFile, 'ProjectFilesMutationOwner')).toBe(1)
    expect(newExpressionCount(facadeFile, 'ProjectFilesQueryOwner')).toBe(1)
    expect(newExpressionCount(facadeFile, 'ProjectFilesMutationOwner', 'transient')).toBe(0)
    expect(newExpressionCount(facadeFile, 'ProjectFilesQueryOwner', 'transient')).toBe(0)

    const fieldInitializerFile = createSourceFile(
      'field-initializer.ts',
      'class ManagedFileIndexRepository { private readonly owner = new ProjectFilesMutationOwner() }',
      ScriptTarget.Latest,
      true,
      ScriptKind.TS
    )
    expect(newExpressionCount(fieldInitializerFile, 'ProjectFilesMutationOwner')).toBe(1)

    const methodConstructionFile = createSourceFile(
      'method-construction.ts',
      'class ManagedFileIndexRepository { createOwner() { return new ProjectFilesMutationOwner() } }',
      ScriptTarget.Latest,
      true,
      ScriptKind.TS
    )
    expect(newExpressionCount(methodConstructionFile, 'ProjectFilesMutationOwner')).toBe(0)
    expect(
      newExpressionCount(methodConstructionFile, 'ProjectFilesMutationOwner', 'transient')
    ).toBe(1)

    const staticFieldFile = createSourceFile(
      'static-field.ts',
      'class ManagedFileIndexRepository { static owner = new ProjectFilesMutationOwner() }',
      ScriptTarget.Latest,
      true,
      ScriptKind.TS
    )
    expect(newExpressionCount(staticFieldFile, 'ProjectFilesMutationOwner')).toBe(0)

    const nestedClassFile = createSourceFile(
      'nested-class.ts',
      'class ManagedFileIndexRepository { createOwner() { class Holder { owner = new ProjectFilesMutationOwner() } return Holder } }',
      ScriptTarget.Latest,
      true,
      ScriptKind.TS
    )
    expect(newExpressionCount(nestedClassFile, 'ProjectFilesMutationOwner')).toBe(0)
  })

  it('keeps Prisma writes and mutation state out of stateless support modules', () => {
    const supportSource = `${sources.get('mutation-projection.ts')}\n${sources.get('query-support.ts')}`
    expect(supportSource).not.toMatch(/\.(?:create|delete|update|updateMany|upsert)\s*\(\s*\{/)
    expect(supportSource).not.toContain('incompleteSessions')
    expect(supportSource).not.toContain('isReconciliationIncomplete')
    expect(supportSource).not.toMatch(/from ['"].*\/repository['"]/)
  })

  it('keeps query orchestration read-only and completeness state in the mutation owner', () => {
    const querySource = sources.get('query-owner.ts')!
    expect(querySource).not.toMatch(/\.(?:create|delete|update|updateMany|upsert)\s*\(\s*\{/)
    expect(querySource).not.toContain('incompleteSessions')
    expect(querySource).not.toContain('isReconciliationIncomplete')
    expect(querySource).not.toMatch(/from ['"].*\/repository['"]/)
  })
})
