import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  canHaveModifiers,
  createSourceFile,
  forEachChild,
  getModifiers,
  isClassDeclaration,
  isConstructorDeclaration,
  isExportDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNamedExports,
  isNewExpression,
  isParameter,
  isPropertyDeclaration,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type ClassDeclaration,
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

const classFrom = (file: (typeof productionFiles)[number], name: string): ClassDeclaration => {
  const candidate = sourceFileFor(file).statements.find(
    (statement) => isClassDeclaration(statement) && statement.name?.text === name
  )
  if (!candidate || !isClassDeclaration(candidate)) throw new Error(`${name} class not found`)
  return candidate
}

const hasModifier = (node: Node, kind: SyntaxKind): boolean =>
  canHaveModifiers(node) &&
  (getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)

const memberName = (node: Node | undefined): string | undefined =>
  node && isIdentifier(node) ? node.text : undefined

const publicMethods = (declaration: ClassDeclaration): string[] =>
  declaration.members
    .filter(isMethodDeclaration)
    .filter(
      (member) =>
        !hasModifier(member, SyntaxKind.PrivateKeyword) &&
        !hasModifier(member, SyntaxKind.ProtectedKeyword)
    )
    .map((member) => memberName(member.name))
    .filter((name): name is string => name !== undefined)
    .sort()

const fields = (declaration: ClassDeclaration): string[] => {
  const result = declaration.members
    .filter(isPropertyDeclaration)
    .map((member) => memberName(member.name))
    .filter((name): name is string => name !== undefined)

  for (const constructor of declaration.members.filter(isConstructorDeclaration)) {
    result.push(
      ...constructor.parameters
        .filter(
          (parameter) =>
            isParameter(parameter) &&
            (hasModifier(parameter, SyntaxKind.PrivateKeyword) ||
              hasModifier(parameter, SyntaxKind.PublicKeyword) ||
              hasModifier(parameter, SyntaxKind.ProtectedKeyword))
        )
        .map((parameter) => memberName(parameter.name))
        .filter((name): name is string => name !== undefined)
    )
  }
  return result.sort()
}

const newExpressionSites = (sourceFile: SourceFile, className: string): string[] => {
  const sites: string[] = []
  const visit = (node: Node): void => {
    if (
      isNewExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === className
    ) {
      let current: Node | undefined = node.parent
      while (current && !isConstructorDeclaration(current)) current = current.parent
      sites.push(current ? 'constructor' : 'outside-constructor')
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)
  return sites
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
  const facade = classFrom('repository.ts', 'ManagedFileIndexRepository')
  const mutationOwner = classFrom('mutation-owner.ts', 'ProjectFilesMutationOwner')
  const queryOwner = classFrom('query-owner.ts', 'ProjectFilesQueryOwner')

  it('keeps every production module within the completion gate', () => {
    for (const [file, source] of sources) {
      const physicalLines = source.split(/\r?\n/).length - Number(source.endsWith('\n'))
      expect(physicalLines, file).toBeLessThanOrEqual(660)
    }
  })

  it('keeps the established public repository interface', () => {
    expect(publicMethods(facade)).toEqual(
      [
        'getOverview',
        'listArtifactGroups',
        'listFiles',
        'markReconciliationIncomplete',
        'readHostArtifactCatalog',
        'reconcileActiveSessions',
        'restoreProject',
        'restoreSession',
        'searchArtifacts',
        'softDeleteProject',
        'softDeleteSession',
        'syncSession'
      ].sort()
    )
  })

  it('keeps the established facade constructor, factory and export inventory', () => {
    const constructors = facade.members.filter(isConstructorDeclaration)
    expect(constructors).toHaveLength(1)
    expect(constructors[0].parameters.map((parameter) => memberName(parameter.name))).toEqual([
      'getClient',
      'dataRoot',
      'legacyArtifactVersionAdopter',
      'legacyUploadVersionUpgrader'
    ])
    expect(newExpressionSites(facadeFile, 'ManagedFileIndexRepository')).toEqual([
      'outside-constructor'
    ])
    expect(namedExports(facadeFile)).toEqual(
      [
        'value:createManagedFileIndexRepository',
        'value:ManagedFileIndexRepository',
        'type:ManagedFileSoftDeleteToken',
        'type:ProjectFilesClient',
        'type:ProjectFilesClientFactory',
        'type:ProjectFilesClientProvider',
        'type:LegacyArtifactVersionAdopter',
        'type:LegacyUploadVersionUpgrader'
      ].sort()
    )
  })

  it('composes one mutation owner and one query owner without shadow lifecycle state', () => {
    expect(newExpressionSites(facadeFile, 'ProjectFilesMutationOwner')).toEqual(['constructor'])
    expect(newExpressionSites(facadeFile, 'ProjectFilesQueryOwner')).toEqual(['constructor'])
    expect(fields(facade)).toEqual(['mutationOwner', 'queryOwner'])
    expect(fields(mutationOwner)).toEqual([
      'dataRoot',
      'getClient',
      'incompleteSessions',
      'isReconciliationIncomplete',
      'legacyArtifactVersionAdopter',
      'legacyUploadVersionUpgrader'
    ])
    expect(fields(queryOwner)).toEqual(['getClient', 'readIndexComplete'])
    expect(publicMethods(queryOwner)).toEqual(
      [
        'getOverview',
        'listArtifactGroups',
        'listFiles',
        'readHostArtifactCatalog',
        'searchArtifacts'
      ].sort()
    )
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
