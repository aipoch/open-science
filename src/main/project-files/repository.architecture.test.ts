import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  createSourceFile,
  forEachChild,
  isExportDeclaration,
  isIdentifier,
  isNamedExports,
  isNewExpression,
  ScriptKind,
  ScriptTarget,
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

const newExpressionCount = (sourceFile: SourceFile, className: string): number => {
  let count = 0
  const visit = (node: Node): void => {
    if (
      isNewExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === className
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

    const fieldInitializerFile = createSourceFile(
      'field-initializer.ts',
      'class Repository { private readonly owner = new ProjectFilesMutationOwner() }',
      ScriptTarget.Latest,
      true,
      ScriptKind.TS
    )
    expect(newExpressionCount(fieldInitializerFile, 'ProjectFilesMutationOwner')).toBe(1)
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
