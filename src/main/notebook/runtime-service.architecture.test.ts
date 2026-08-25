import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  canHaveModifiers,
  createSourceFile,
  forEachChild,
  getModifiers,
  isArrowFunction,
  isClassDeclaration,
  isConstructorDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isParameter,
  isPropertyDeclaration,
  isVariableStatement,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type ClassDeclaration,
  type NewExpression,
  type SourceFile,
  type Node
} from 'typescript'
import { describe, expect, it } from 'vitest'

const facadePath = resolve(__dirname, 'runtime-service.ts')
const facadeSource = readFileSync(facadePath, 'utf8')
const sourceFileFor = (source: string): SourceFile =>
  createSourceFile(facadePath, source, ScriptTarget.Latest, true, ScriptKind.TS)
const facadeClassFrom = (sourceFile: SourceFile): ClassDeclaration => {
  const candidate = sourceFile.statements.find(
    (statement) =>
      isClassDeclaration(statement) && statement.name?.text === 'NotebookRuntimeService'
  )
  if (!candidate || !isClassDeclaration(candidate)) {
    throw new Error('NotebookRuntimeService class not found')
  }
  return candidate
}
const facadeFile = sourceFileFor(facadeSource)
const facadeClass = facadeClassFrom(facadeFile)

const hasModifier = (node: Node, kind: SyntaxKind): boolean =>
  canHaveModifiers(node) &&
  (getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)

const identifierName = (node: Node | undefined): string | undefined =>
  node && isIdentifier(node) ? node.text : undefined

const facadeFields = (): readonly string[] => {
  const fields = facadeClass.members
    .filter(isPropertyDeclaration)
    .map((member) => identifierName(member.name))
    .filter((name): name is string => name !== undefined)

  for (const constructor of facadeClass.members.filter(isConstructorDeclaration)) {
    fields.push(
      ...constructor.parameters
        .filter(
          (parameter) =>
            isParameter(parameter) &&
            (hasModifier(parameter, SyntaxKind.PrivateKeyword) ||
              hasModifier(parameter, SyntaxKind.PublicKeyword) ||
              hasModifier(parameter, SyntaxKind.ProtectedKeyword))
        )
        .map((parameter) => identifierName(parameter.name))
        .filter((name): name is string => name !== undefined)
    )
  }

  return fields.sort()
}

const mutableFacadeFields = (): readonly string[] =>
  facadeClass.members
    .filter(isPropertyDeclaration)
    .filter((member) => !hasModifier(member, SyntaxKind.ReadonlyKeyword))
    .map((member) => identifierName(member.name))
    .filter((name): name is string => name !== undefined)
    .sort()

const facadeMethods = (
  visibility: 'public' | 'private',
  target: ClassDeclaration = facadeClass
): readonly string[] =>
  target.members
    .filter(isMethodDeclaration)
    .filter((member) =>
      visibility === 'private'
        ? hasModifier(member, SyntaxKind.PrivateKeyword)
        : !hasModifier(member, SyntaxKind.PrivateKeyword) &&
          !hasModifier(member, SyntaxKind.ProtectedKeyword)
    )
    .map((member) => identifierName(member.name))
    .filter((name): name is string => name !== undefined)
    .sort()

const topLevelValueNames = (sourceFile: SourceFile = facadeFile): readonly string[] =>
  sourceFile.statements
    .flatMap((statement) => {
      if (isVariableStatement(statement)) {
        return statement.declarationList.declarations.map((declaration) =>
          declaration.name.getText(sourceFile)
        )
      }
      if (isFunctionDeclaration(statement)) return [statement.name?.text ?? '<anonymous>']
      return []
    })
    .sort()

const constructionSite = (expression: NewExpression): string => {
  let current: Node | undefined = expression.parent
  while (current) {
    if (isConstructorDeclaration(current)) return 'constructor'
    if (isMethodDeclaration(current)) {
      return `method:${identifierName(current.name) ?? '<computed>'}`
    }
    if (
      isArrowFunction(current) ||
      isFunctionExpression(current) ||
      isFunctionDeclaration(current)
    ) {
      return 'nested-function'
    }
    current = current.parent
  }
  return 'module'
}

const ownerConstructionSites = (
  sourceFile: SourceFile = facadeFile
): ReadonlyMap<string, readonly string[]> => {
  const sites = new Map<string, string[]>()
  const visit = (node: Node): void => {
    if (isNewExpression(node) && isIdentifier(node.expression)) {
      const ownerSites = sites.get(node.expression.text) ?? []
      ownerSites.push(constructionSite(node))
      sites.set(node.expression.text, ownerSites)
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)
  return sites
}

describe('Notebook runtime facade architecture', () => {
  it('keeps the compatibility facade within its completion gate', () => {
    const physicalLines = facadeSource.split(/\r?\n/).length - Number(facadeSource.endsWith('\n'))

    expect(physicalLines).toBeLessThanOrEqual(1250)
  })

  it('keeps package, repair, and Session lifecycle state behind owners', () => {
    expect(topLevelValueNames()).toEqual(
      [
        'DEFAULT_LOCALE',
        'EMPTY_NOTEBOOK_RUNTIME_SETTINGS',
        'dataProcessKey',
        'resolveDefaultExecutorOptions',
        'resolveLoopScript',
        'resolveLoopScriptPaths',
        'saveIpynbWithDialog'
      ].sort()
    )
    expect(facadeFields()).toEqual(
      [
        'dataExecutionAdmission',
        'dependencyAnalyzer',
        'disposalPromise',
        'environmentManagement',
        'environmentOperations',
        'environmentStateTracker',
        'executionOwner',
        'exportReader',
        'mcpRpcConnectionResolver',
        'options',
        'packageOperations',
        'recoveryCoordinator',
        'repairPolicy',
        'repository',
        'runTerminalization',
        'runtimeBindingOwner',
        'runtimeEnablementResolver',
        'runtimeLogger',
        'runtimeRepair',
        'sessionLifecycle',
        'sessionReadModel',
        'sessions'
      ].sort()
    )
    expect(mutableFacadeFields()).toEqual(['disposalPromise', 'mcpRpcConnectionResolver'])
  })

  it('composes each state owner exactly once', () => {
    const sites = ownerConstructionSites()
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

    for (const owner of owners) expect(sites.get(owner), owner).toEqual(['constructor'])
  })

  it('keeps the established public facade surface', () => {
    expect(facadeMethods('public')).toEqual(
      [
        'appendCodeCell',
        'beginCodeCell',
        'beginProjectDeletion',
        'bindRuntime',
        'blockPrefixRecovery',
        'clearCorruptRecoveryBlock',
        'clearRecoveryBlock',
        'clearRuntimeRecoveryBlock',
        'completeRuntimeRepair',
        'describeRuntimeUsage',
        'dispose',
        'ensureRecovered',
        'execute',
        'executeControl',
        'executeShell',
        'exportIpynb',
        'exportIpynbAll',
        'finishCodeCell',
        'getActiveNotebookSessions',
        'getSessionReference',
        'inspectPackages',
        'isDefaultEnvRecoveryBlocked',
        'isPrefixLiveUnconfirmed',
        'isPrefixRecoveryBlocked',
        'listRuntimes',
        'manageEnvironments',
        'managePackages',
        'peekHandoffContext',
        'recoverInterruptedOperations',
        'releaseProjectDeletion',
        'restart',
        'revokeRuntime',
        'runCell',
        'setControlCompletionInterceptor',
        'setDefaultEnvProvisioner',
        'setEnvironmentManager',
        'setMcpRpcConnectionResolver',
        'shutdown',
        'shutdownAll',
        'shutdownProject',
        'shutdownSession',
        'state',
        'switchRuntime',
        'withEnvLock'
      ].sort()
    )
  })

  it('keeps only stateless policy helpers in the facade', () => {
    expect(facadeMethods('private')).toEqual(
      [
        'assertPrefixRecoverable',
        'defaultEnvNameFor',
        'environmentCaptureTarget',
        'isDefaultEnvDisabled',
        'resolveRunEnv',
        'resolveRuntimeEnablement',
        'tearDownLanguageBinding'
      ].sort()
    )
  })

  it('rejects module state, duplicate or lazy owners, and protected public methods', () => {
    const moduleStateFile = sourceFileFor(`${facadeSource}\nconst leakedSessions = new Map()\n`)
    expect(topLevelValueNames(moduleStateFile)).toContain('leakedSessions')

    const duplicateOwnerFile = sourceFileFor(
      `${facadeSource}\nnew NotebookSessionLifecycleOwner({} as never)\n`
    )
    expect(ownerConstructionSites(duplicateOwnerFile).get('NotebookSessionLifecycleOwner')).toEqual(
      ['constructor', 'module']
    )

    const lazyOwnerFile = sourceFileFor(`
      class NotebookRuntimeService {
        constructor() {
          const createOwner = () => new NotebookSessionLifecycleOwner({} as never)
          void createOwner
        }
      }
    `)
    expect(ownerConstructionSites(lazyOwnerFile).get('NotebookSessionLifecycleOwner')).toEqual([
      'nested-function'
    ])

    const protectedMethodFile = sourceFileFor(
      facadeSource.replace('  async listRuntimes(', '  protected async listRuntimes(')
    )
    expect(facadeMethods('public', facadeClassFrom(protectedMethodFile))).not.toContain(
      'listRuntimes'
    )
  })
})
