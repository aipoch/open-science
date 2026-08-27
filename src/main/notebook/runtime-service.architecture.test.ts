import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  createSourceFile,
  forEachChild,
  isIdentifier,
  isNewExpression,
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
          return mutableDeclaration || mutableCollection
        })
        .map((declaration) => declaration.name.getText(sourceFile))
    )
    .sort()

const ownerConstructionCounts = (
  sourceFile: SourceFile = facadeFile
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>()
  const visit = (node: Node): void => {
    if (isNewExpression(node) && isIdentifier(node.expression)) {
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
    const counts = ownerConstructionCounts()
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

    for (const owner of owners) expect(counts.get(owner), owner).toBe(1)
  })

  it('detects module state and duplicate owners without fixing their construction syntax', () => {
    const moduleStateFile = sourceFileFor(`${facadeSource}\nconst leakedSessions = new Map()\n`)
    expect(moduleStateNames(moduleStateFile)).toContain('leakedSessions')

    const duplicateOwnerFile = sourceFileFor(
      `${facadeSource}\nnew NotebookSessionLifecycleOwner({} as never)\n`
    )
    expect(ownerConstructionCounts(duplicateOwnerFile).get('NotebookSessionLifecycleOwner')).toBe(2)

    const fieldInitializerFile = sourceFileFor(`
      class NotebookRuntimeService {
        private readonly sessionLifecycle = new NotebookSessionLifecycleOwner({} as never)
      }
    `)
    expect(ownerConstructionCounts(fieldInitializerFile).get('NotebookSessionLifecycleOwner')).toBe(
      1
    )
  })
})
