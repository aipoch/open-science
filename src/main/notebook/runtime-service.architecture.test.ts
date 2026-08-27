import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  createSourceFile,
  forEachChild,
  isArrayLiteralExpression,
  isArrowFunction,
  isConstructorDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isVariableStatement,
  NodeFlags,
  ScriptKind,
  ScriptTarget,
  type SourceFile,
  type Node
} from 'typescript'
import { describe, expect, it } from 'vitest'

const facadePath = resolve(__dirname, 'runtime-service.ts')
const facadeSource = readFileSync(facadePath, 'utf8')
const sourceFileFor = (source: string): SourceFile =>
  createSourceFile(facadePath, source, ScriptTarget.Latest, true, ScriptKind.TS)
const facadeFile = sourceFileFor(facadeSource)
const statefulConstructors = new Set(['Map', 'Set', 'WeakMap', 'WeakSet'])
const isStatelessPolicyObject = (node: Node): boolean =>
  isObjectLiteralExpression(node) &&
  node.properties.length > 0 &&
  node.properties.every(
    (property) =>
      isMethodDeclaration(property) ||
      (isPropertyAssignment(property) &&
        (isArrowFunction(property.initializer) || isFunctionExpression(property.initializer)))
  )
const moduleStateNames = (sourceFile: SourceFile = facadeFile): readonly string[] =>
  sourceFile.statements
    .filter(isVariableStatement)
    .flatMap((statement) =>
      statement.declarationList.declarations
        .filter((declaration) => {
          const mutableDeclaration =
            (statement.declarationList.flags & NodeFlags.Const) !== NodeFlags.Const
          const initializer = declaration.initializer
          const mutableCollection =
            initializer !== undefined &&
            isNewExpression(initializer) &&
            isIdentifier(initializer.expression) &&
            statefulConstructors.has(initializer.expression.text)
          const mutableLiteral =
            initializer !== undefined &&
            (isArrayLiteralExpression(initializer) ||
              (isObjectLiteralExpression(initializer) && !isStatelessPolicyObject(initializer)))
          return mutableDeclaration || mutableCollection || mutableLiteral
        })
        .map((declaration) => declaration.name.getText(sourceFile))
    )
    .sort()

const hasClassLifetime = (expression: Node): boolean => {
  let current: Node | undefined = expression.parent
  while (current) {
    if (isConstructorDeclaration(current) || isPropertyDeclaration(current)) return true
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

const ownerConstructionCounts = (
  sourceFile: SourceFile = facadeFile,
  lifetime: 'class' | 'transient' = 'class'
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>()
  const visit = (node: Node): void => {
    if (
      isNewExpression(node) &&
      isIdentifier(node.expression) &&
      (hasClassLifetime(node) ? 'class' : 'transient') === lifetime
    ) {
      counts.set(node.expression.text, (counts.get(node.expression.text) ?? 0) + 1)
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)
  return counts
}

describe('Notebook runtime facade architecture', () => {
  it('keeps mutable module state behind owners', () => {
    expect(moduleStateNames()).toEqual([])
  })

  it('composes each state owner exactly once', () => {
    const classLifetimeCounts = ownerConstructionCounts()
    const transientCounts = ownerConstructionCounts(facadeFile, 'transient')
    const owners = [
      'NotebookDataExecutionAdmissionOwner',
      'NotebookEnvironmentManagementOwner',
      'NotebookEnvironmentOperations',
      'NotebookExecutionOwner',
      'NotebookExportReader',
      'NotebookPackageOperations',
      'NotebookRecoveryCoordinator',
      'NotebookRunTerminalizationOwner',
      'NotebookRuntimeBindingOwner',
      'NotebookRuntimeRepairOwner',
      'NotebookRuntimeRepairPolicy',
      'NotebookSessionLifecycleOwner',
      'NotebookSessionReadModel',
      'NotebookSessionRegistry'
    ]

    for (const owner of owners) {
      expect(classLifetimeCounts.get(owner), owner).toBe(1)
      expect(transientCounts.get(owner) ?? 0, owner).toBe(0)
    }
  })

  it('detects module state and duplicate owners without fixing their construction syntax', () => {
    const moduleStateFile = sourceFileFor(`${facadeSource}\nconst leakedSessions = new Map()\n`)
    expect(moduleStateNames(moduleStateFile)).toContain('leakedSessions')

    const arrayStateFile = sourceFileFor(`${facadeSource}\nconst leakedSessions = []\n`)
    expect(moduleStateNames(arrayStateFile)).toContain('leakedSessions')

    const objectStateFile = sourceFileFor(`${facadeSource}\nconst leakedSessions = {}\n`)
    expect(moduleStateNames(objectStateFile)).toContain('leakedSessions')

    const duplicateOwnerFile = sourceFileFor(
      `${facadeSource}\nnew NotebookSessionLifecycleOwner({} as never)\n`
    )
    expect(ownerConstructionCounts(duplicateOwnerFile).get('NotebookSessionLifecycleOwner')).toBe(1)
    expect(
      ownerConstructionCounts(duplicateOwnerFile, 'transient').get('NotebookSessionLifecycleOwner')
    ).toBe(1)

    const fieldInitializerFile = sourceFileFor(`
      class NotebookRuntimeService {
        private readonly sessionLifecycle = new NotebookSessionLifecycleOwner({} as never)
      }
    `)
    expect(ownerConstructionCounts(fieldInitializerFile).get('NotebookSessionLifecycleOwner')).toBe(
      1
    )

    const methodConstructionFile = sourceFileFor(`
      class NotebookRuntimeService {
        createSessionLifecycle() {
          return new NotebookSessionLifecycleOwner({} as never)
        }
      }
    `)
    expect(
      ownerConstructionCounts(methodConstructionFile).get('NotebookSessionLifecycleOwner')
    ).toBeUndefined()
  })
})
