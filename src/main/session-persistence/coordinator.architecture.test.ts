import { readFileSync, readdirSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

import {
  canHaveModifiers,
  createSourceFile,
  forEachChild,
  getModifiers,
  isArrayLiteralExpression,
  isArrowFunction,
  isAwaitExpression,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isConstructorDeclaration,
  isEnumDeclaration,
  isExportAssignment,
  isExportDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isImportDeclaration,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isModuleDeclaration,
  isNamedExports,
  isNamedImports,
  isNamespaceImport,
  isNewExpression,
  isObjectLiteralExpression,
  isParameter,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isReturnStatement,
  isSetAccessorDeclaration,
  isStringLiteralLike,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  isVariableStatement,
  NodeFlags,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type ClassDeclaration,
  type MethodDeclaration,
  type Node,
  type SourceFile
} from 'typescript'
import { describe, expect, it } from 'vitest'

import { loadModuleImpactManifest } from '../../../scripts/ci/load-module-impact.mjs'

const productionFiles = [
  'coordinator.ts',
  'delegated-question-owner.ts',
  'delegated-work-owner.ts',
  'delegated-work-store.ts',
  'deletion-owner.ts',
  'legacy-upload.ts',
  'message-delivery-owner.ts',
  'reconciliation-owner.ts',
  'relay-projection.ts',
  'session-details-authority.ts',
  'side-chat-owner.ts',
  'state-owner.ts'
] as const
type ProductionFile = (typeof productionFiles)[number]

const projectRoot = resolve(__dirname, '../../..')
const sources = new Map(
  productionFiles.map((file) => [file, readFileSync(resolve(__dirname, file), 'utf8')])
)
const sourceFileFor = (file: ProductionFile): SourceFile =>
  createSourceFile(file, sources.get(file)!, ScriptTarget.Latest, true, ScriptKind.TS)

const classFrom = (file: ProductionFile, name: string): ClassDeclaration => {
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

const methods = (declaration: ClassDeclaration, visibility: 'public' | 'private'): string[] =>
  declaration.members
    .filter(isMethodDeclaration)
    .filter((member) =>
      visibility === 'private'
        ? hasModifier(member, SyntaxKind.PrivateKeyword)
        : !hasModifier(member, SyntaxKind.PrivateKeyword) &&
          !hasModifier(member, SyntaxKind.ProtectedKeyword)
    )
    .map((member) => memberName(member.name))
    .filter((name): name is string => name !== undefined)
    .sort()

const publicNonMethodMembers = (declaration: ClassDeclaration): string[] =>
  declaration.members
    .filter(
      (member) =>
        (isPropertyDeclaration(member) ||
          isGetAccessorDeclaration(member) ||
          isSetAccessorDeclaration(member)) &&
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

const mutableFields = (declaration: ClassDeclaration): string[] => {
  const result = declaration.members
    .filter(isPropertyDeclaration)
    .filter((member) => !hasModifier(member, SyntaxKind.ReadonlyKeyword))
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
              hasModifier(parameter, SyntaxKind.ProtectedKeyword)) &&
            !hasModifier(parameter, SyntaxKind.ReadonlyKeyword)
        )
        .map((parameter) => memberName(parameter.name))
        .filter((name): name is string => name !== undefined)
    )
  }
  return result.sort()
}

const methodFrom = (declaration: ClassDeclaration, name: string): MethodDeclaration => {
  const method = declaration.members.find(
    (member) => isMethodDeclaration(member) && memberName(member.name) === name
  )
  if (!method || !isMethodDeclaration(method)) throw new Error(`${name} method not found`)
  return method
}

const walk = (root: Node, predicate: (node: Node) => boolean): Node[] => {
  const matches: Node[] = []
  const visit = (node: Node): void => {
    if (predicate(node)) matches.push(node)
    forEachChild(node, visit)
  }
  visit(root)
  return matches
}

const calledOwnerMethods = (method: MethodDeclaration): string[] =>
  walk(
    method,
    (node) =>
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.expression.kind === SyntaxKind.ThisKeyword &&
      [
        'stateOwner',
        'deletionOwner',
        'reconciliationOwner',
        'sideChatOwner',
        'messageDeliveryOwner',
        'delegatedWorkOwner'
      ].includes(node.expression.expression.name.text)
  )
    .map((node) => {
      const call = node
      if (!isCallExpression(call) || !isPropertyAccessExpression(call.expression)) return ''
      const owner = call.expression.expression
      if (!isPropertyAccessExpression(owner)) return ''
      return `${owner.name.text}.${call.expression.name.text}`
    })
    .sort()

const sessionDependencies = (file: ProductionFile): string[] =>
  sourceFileFor(file)
    .statements.filter(isImportDeclaration)
    .flatMap((statement) => {
      if (!isStringLiteralLike(statement.moduleSpecifier)) return []
      const specifier = statement.moduleSpecifier.text
      if (!specifier.startsWith('.')) return []
      const target = resolve(__dirname, specifier)
      const dependency = productionFiles.find(
        (candidate) => resolve(__dirname, candidate.replace(/\.ts$/, '')) === target
      )
      return dependency ? [dependency] : []
    })
    .sort()

const exportedNames = (sourceFile: SourceFile, kind: 'value' | 'type'): string[] => {
  const names: string[] = []
  for (const statement of sourceFile.statements) {
    if (isExportDeclaration(statement)) {
      if (!statement.exportClause || !isNamedExports(statement.exportClause)) {
        if ((kind === 'type') === statement.isTypeOnly) {
          names.push(`export-all:${statement.moduleSpecifier?.getText(sourceFile) ?? '<local>'}`)
        }
        continue
      }
      for (const element of statement.exportClause.elements) {
        const isType = statement.isTypeOnly || element.isTypeOnly
        if ((kind === 'type') === isType) names.push(element.name.text)
      }
      continue
    }
    if (isExportAssignment(statement) && kind === 'value') names.push('default')
    if (!hasModifier(statement, SyntaxKind.ExportKeyword)) continue
    const valueDeclaration =
      isClassDeclaration(statement) ||
      isFunctionDeclaration(statement) ||
      isEnumDeclaration(statement) ||
      isModuleDeclaration(statement)
    const typeDeclaration = isInterfaceDeclaration(statement) || isTypeAliasDeclaration(statement)
    if (kind === 'value' && valueDeclaration) {
      const name = statement.name?.text ?? '<anonymous>'
      names.push(hasModifier(statement, SyntaxKind.DefaultKeyword) ? `default:${name}` : name)
    } else if (kind === 'type' && typeDeclaration && statement.name) {
      names.push(statement.name.text)
    } else if (kind === 'value' && isVariableStatement(statement)) {
      names.push(...statement.declarationList.declarations.map((item) => item.name.getText()))
    }
  }
  return names.sort()
}

const statefulTopLevelVariables = (file: ProductionFile): string[] =>
  sourceFileFor(file)
    .statements.filter(isVariableStatement)
    .flatMap((statement) =>
      statement.declarationList.declarations
        .filter((declaration) => {
          const initializer = declaration.initializer
          if ((statement.declarationList.flags & NodeFlags.Const) === 0) return true
          if (!initializer || isArrowFunction(initializer) || isFunctionExpression(initializer)) {
            return false
          }
          return (
            isNewExpression(initializer) ||
            isArrayLiteralExpression(initializer) ||
            isObjectLiteralExpression(initializer) ||
            isCallExpression(initializer)
          )
        })
        .map((declaration) => declaration.name.getText())
    )
    .sort()

const staticStateFields = (file: ProductionFile): string[] =>
  walk(
    sourceFileFor(file),
    (node) => isPropertyDeclaration(node) && hasModifier(node, SyntaxKind.StaticKeyword)
  )
    .filter(isPropertyDeclaration)
    .map((field) => memberName(field.name) ?? '<computed>')
    .sort()

const findTypeScriptFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return findTypeScriptFiles(path)
    return entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test-support.ts')
      ? [path]
      : []
  })

const constructionSites = (className: string): string[] => {
  const sites: string[] = []
  for (const path of findTypeScriptFiles(resolve(projectRoot, 'src/main'))) {
    const source = readFileSync(path, 'utf8')
    if (!source.includes(className)) continue
    const sourceFile = createSourceFile(path, source, ScriptTarget.Latest, true, ScriptKind.TS)
    const localNames = new Set([className])
    const namespaceNames = new Set<string>()
    for (const statement of sourceFile.statements.filter(isImportDeclaration)) {
      const bindings = statement.importClause?.namedBindings
      if (bindings && isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === className) {
            localNames.add(element.name.text)
          }
        }
      } else if (bindings && isNamespaceImport(bindings)) {
        namespaceNames.add(bindings.name.text)
      }
    }
    let foundAlias = true
    while (foundAlias) {
      foundAlias = false
      for (const declaration of walk(sourceFile, isVariableDeclaration).filter(
        isVariableDeclaration
      )) {
        if (!isIdentifier(declaration.name) || !declaration.initializer) continue
        const initializer = declaration.initializer
        const aliasesClass =
          (isIdentifier(initializer) && localNames.has(initializer.text)) ||
          (isPropertyAccessExpression(initializer) &&
            isIdentifier(initializer.expression) &&
            namespaceNames.has(initializer.expression.text) &&
            initializer.name.text === className)
        if (aliasesClass && !localNames.has(declaration.name.text)) {
          localNames.add(declaration.name.text)
          foundAlias = true
        }
      }
    }
    for (const node of walk(
      sourceFile,
      (candidate) =>
        isNewExpression(candidate) &&
        ((isIdentifier(candidate.expression) && localNames.has(candidate.expression.text)) ||
          (isPropertyAccessExpression(candidate.expression) &&
            isIdentifier(candidate.expression.expression) &&
            namespaceNames.has(candidate.expression.expression.text) &&
            candidate.expression.name.text === className))
    )) {
      let current: Node | undefined = node.parent
      while (current && !isConstructorDeclaration(current) && !isMethodDeclaration(current)) {
        current = current.parent
      }
      sites.push(
        `${relative(projectRoot, path).split(sep).join('/')}:${
          current && isMethodDeclaration(current)
            ? memberName(current.name)
            : current
              ? 'constructor'
              : 'module'
        }`
      )
    }
  }
  return sites.sort()
}

const concreteCoordinatorConsumerFiles = (): string[] =>
  findTypeScriptFiles(resolve(projectRoot, 'src/main'))
    .filter((path) => !path.endsWith('/session-persistence/coordinator.ts'))
    .filter((path) => path !== resolve(projectRoot, 'src/main/ipc.ts'))
    .filter((path) => {
      const sourceFile = createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ScriptTarget.Latest,
        true,
        ScriptKind.TS
      )
      return sourceFile.statements.filter(isImportDeclaration).some((statement) => {
        if (!isStringLiteralLike(statement.moduleSpecifier)) return false
        const importedPath = resolve(path, '..', statement.moduleSpecifier.text)
        if (importedPath !== resolve(__dirname, 'coordinator')) return false
        const bindings = statement.importClause?.namedBindings
        return (
          bindings !== undefined &&
          isNamedImports(bindings) &&
          bindings.elements.some(
            (element) =>
              (element.propertyName ?? element.name).text === 'SessionPersistenceCoordinator'
          )
        )
      })
    })
    .map((path) => relative(projectRoot, path).split(sep).join('/'))
    .sort()

describe('Session persistence coordinator architecture', () => {
  const facadeFile = sourceFileFor('coordinator.ts')
  const facade = classFrom('coordinator.ts', 'SessionPersistenceCoordinator')
  const stateOwner = classFrom('state-owner.ts', 'SessionPersistenceStateOwner')
  const sideChatOwner = classFrom('side-chat-owner.ts', 'SessionSideChatPersistenceOwner')
  const deletionOwner = classFrom('deletion-owner.ts', 'SessionPersistenceDeletionOwner')
  const reconciliationOwner = classFrom(
    'reconciliation-owner.ts',
    'SessionPersistenceReconciliationOwner'
  )
  const messageDeliveryOwner = classFrom(
    'message-delivery-owner.ts',
    'SessionMessageDeliveryPersistenceOwner'
  )
  const delegatedWorkOwner = classFrom(
    'delegated-work-owner.ts',
    'SessionDelegatedWorkPersistenceOwner'
  )
  const delegatedWorkStore = classFrom('delegated-work-store.ts', 'SessionDelegatedWorkStore')
  const delegatedQuestionOwner = classFrom(
    'delegated-question-owner.ts',
    'SessionDelegatedQuestionPersistenceOwner'
  )

  it('keeps the established facade, constructor, and module exports', () => {
    expect(methods(facade, 'public')).toEqual(
      [
        'acknowledgeUncertainMessage',
        'admitMessageCommand',
        'admitQuestion',
        'adoptPublishedSession',
        'appendSideChatRelay',
        'appendUserMessageToInteraction',
        'applyAgentEvent',
        'assertProjectArchivable',
        'assertSessionAvailable',
        'attachDelegatedMessageArtifacts',
        'cancelQuestions',
        'clearSideChat',
        'commitSideChatRelays',
        'completeChildTurn',
        'completeProjectSessionDeletion',
        'confirmQuestion',
        'containsMessageOnActiveBranch',
        'createChildren',
        'deleteProjectSessions',
        'deleteSession',
        'failTaskRun',
        'getProjectSessionDeletionState',
        'listLegacyProjectSessionTombstones',
        'loadAll',
        'loadAllReadOnly',
        'loadSessionForContinuation',
        'loadPersistedSideChats',
        'markCommittedProjectSessionsPrepared',
        'mutateRuntimeSession',
        'mutateSessionComputeHostAccess',
        'mutateSessionDetailsAuthority',
        'patchSessionRuntimeContext',
        'pruneSessionEnabledComputeHosts',
        'readChildren',
        'withUnreferencedLiteratureAttachment',
        'withLiteratureAttachmentRemoval',
        'readSessionRuntimeContext',
        'readSessionSnapshot',
        'recoverInterruptedDelegatedWork',
        'replaceSessionMetadata',
        'repairProjectFiles',
        'reserveSessionExport',
        'retryArtifactFinalization',
        'runSessionMutation',
        'saveManifest',
        'saveSession',
        'saveSessionSpecialistBinding',
        'saveSideChatProjection',
        'sessionMetadataSnapshot',
        'sessionProjectId',
        'setSessionComputeConcurrencyLimit',
        'setSessionDelegationPolicy',
        'setSessionDeletionHandlers',
        'setSessionEnabledComputeHosts',
        'settleMessage',
        'settleTaskCompletion',
        'bindTaskSession',
        'prepareRuntimeResume',
        'admitTaskTurn',
        'stageTaskCompletion',
        'startAttemptRuntime',
        'startContinuationAttempt',
        'startMessageDispatch',
        'startPendingMessageTurn',
        'submitStructuredOutput',
        'transitionAttempt',
        'updateArchive',
        'updateSessionConfiguration',
        'updateQuestionDraft'
      ].sort()
    )
    expect(methods(facade, 'private')).toEqual(
      ['assertMutable', 'notifyFilesChanged', 'notifySessionsDeleted'].sort()
    )
    expect(publicNonMethodMembers(facade)).toEqual([])

    const constructors = facade.members.filter(isConstructorDeclaration)
    expect(constructors).toHaveLength(1)
    expect(
      constructors[0].parameters.map(
        (parameter) =>
          `${parameter.name.getText(facadeFile)}:${
            parameter.initializer ? 'defaulted' : parameter.questionToken ? 'optional' : 'required'
          }`
      )
    ).toEqual([
      'repository:required',
      'fileIndex:required',
      'onFilesChanged:optional',
      'provenance:optional',
      'uploads:optional',
      'artifactStorage:optional',
      'permissionGrants:optional',
      'log:defaulted',
      'computeJobs:optional',
      'onDelegatedWorkSessionUpdated:optional',
      'onDelegationPolicyUpdated:optional',
      'workspaceOwnership:optional',
      'preparePackageDeletion:optional'
    ])
    expect(exportedNames(facadeFile, 'value')).toEqual(
      ['SessionPersistenceCoordinator', 'SessionRuntimeContextRevisionConflictError'].sort()
    )
    expect(exportedNames(facadeFile, 'type')).toEqual(
      [
        'ComputeJobDeletionParticipant',
        'DelegatedWorkRecordCommands',
        'PatchSessionRuntimeContextCommand',
        'ProjectSessionDeletionResult',
        'SessionCatalog',
        'SessionDeletion',
        'SessionDeletionHandlers',
        'SessionFileIndex',
        'SessionMetadata',
        'SessionMetadataSnapshot',
        'SessionMutation',
        'SessionMutationRepository',
        'SessionProvenancePersistence',
        'SessionRuntimeContextCommands'
      ].sort()
    )
  })

  it('keeps production consumers on named capability views', () => {
    expect(concreteCoordinatorConsumerFiles()).toEqual([])
  })

  it('composes each owner once and keeps mutable state with its sole owner', () => {
    expect(fields(facade)).toEqual(
      [
        'computeJobs',
        'delegatedStartupRecoveryComplete',
        'deletedProjects',
        'deletedSessions',
        'deletionOwner',
        'destructiveStartupWindowOpen',
        'exportingSessions',
        'fileIndex',
        'log',
        'delegatedWorkOwner',
        'onFilesChanged',
        'operationScheduler',
        'reconciliationOwner',
        'repository',
        'sessionDeletionHandlers',
        'sideChatOwner',
        'stateOwner',
        'workspaceOwnership'
      ].sort()
    )
    expect(mutableFields(facade)).toEqual(
      [
        'delegatedStartupRecoveryComplete',
        'destructiveStartupWindowOpen',
        'sessionDeletionHandlers'
      ].sort()
    )
    expect(mutableFields(stateOwner)).toEqual(
      ['isSessionMetadataComplete', 'sessionMetadata'].sort()
    )
    expect(mutableFields(deletionOwner)).toEqual([])
    expect(mutableFields(reconciliationOwner)).toEqual([])
    expect(mutableFields(sideChatOwner)).toEqual([])
    expect(mutableFields(messageDeliveryOwner)).toEqual([])
    expect(mutableFields(delegatedWorkOwner)).toEqual([])
    expect(mutableFields(delegatedWorkStore)).toEqual([])
    expect(mutableFields(delegatedQuestionOwner)).toEqual([])
    expect(publicNonMethodMembers(stateOwner)).toEqual([])
    expect(publicNonMethodMembers(deletionOwner)).toEqual([])
    expect(publicNonMethodMembers(reconciliationOwner)).toEqual([])
    expect(publicNonMethodMembers(sideChatOwner)).toEqual([])
    expect(publicNonMethodMembers(messageDeliveryOwner)).toEqual([])
    expect(publicNonMethodMembers(delegatedWorkOwner)).toEqual([])
    expect(publicNonMethodMembers(delegatedWorkStore)).toEqual([])
    expect(publicNonMethodMembers(delegatedQuestionOwner)).toEqual([])
    expect(fields(stateOwner)).toEqual(
      [
        'isSessionMetadataComplete',
        'options',
        'sessionMetadata',
        'validatedBindingTopologies'
      ].sort()
    )
    expect(fields(deletionOwner)).toEqual(
      [
        'assertArchiveMutable',
        'computeJobs',
        'fileIndex',
        'log',
        'notifyFilesChanged',
        'notifySessionsDeleted',
        'preparePackageDeletion',
        'provenance',
        'repository',
        'stateOwner',
        'uploads',
        'workspaceOwnership'
      ].sort()
    )
    expect(fields(reconciliationOwner)).toEqual(
      [
        'artifactStorage',
        'fileIndex',
        'permissionGrants',
        'provenance',
        'repository',
        'uploads'
      ].sort()
    )
    expect(fields(sideChatOwner)).toEqual(['options'])
    for (const file of productionFiles) {
      expect(statefulTopLevelVariables(file), file).toEqual(
        file === 'deletion-owner.ts' ? ['ARCHIVE_BLOCKING_SESSION_STATUSES'] : []
      )
      expect(staticStateFields(file), file).toEqual([])
    }

    expect(constructionSites('SessionPersistenceCoordinator')).toEqual(['src/main/ipc.ts:module'])
    expect(constructionSites('SessionPersistenceStateOwner')).toEqual([
      'src/main/session-persistence/coordinator.ts:constructor'
    ])
    expect(constructionSites('SessionPersistenceDeletionOwner')).toEqual([
      'src/main/session-persistence/coordinator.ts:constructor'
    ])
    expect(constructionSites('SessionPersistenceReconciliationOwner')).toEqual([
      'src/main/session-persistence/coordinator.ts:constructor'
    ])
    expect(constructionSites('SessionSideChatPersistenceOwner')).toEqual([
      'src/main/session-persistence/coordinator.ts:constructor'
    ])
    expect(constructionSites('SessionMessageDeliveryPersistenceOwner')).toEqual([
      'src/main/session-persistence/delegated-work-owner.ts:module'
    ])
    expect(constructionSites('SessionDelegatedWorkPersistenceOwner')).toEqual([
      'src/main/session-persistence/coordinator.ts:constructor'
    ])
    expect(constructionSites('SessionDelegatedWorkStore')).toEqual([
      'src/main/session-persistence/delegated-work-owner.ts:constructor'
    ])
    expect(constructionSites('SessionDelegatedQuestionPersistenceOwner')).toEqual([
      'src/main/session-persistence/delegated-work-owner.ts:constructor'
    ])
    expect(constructionSites('SessionPersistenceOperationScheduler')).toEqual([
      'src/main/session-persistence/coordinator.ts:module',
      'src/main/session-persistence/repository.ts:module'
    ])
  })

  it('routes every asynchronous public operation through its owning scheduler scope', () => {
    const handlerSetter = methodFrom(facade, 'setSessionDeletionHandlers')
    expect(hasModifier(handlerSetter, SyntaxKind.AsyncKeyword)).toBe(false)
    expect(handlerSetter.type?.kind).toBe(SyntaxKind.VoidKeyword)
    expect(walk(handlerSetter, isAwaitExpression)).toEqual([])
    const schedulerRoutes: Record<string, string[]> = {
      runGlobal: [
        'withUnreferencedLiteratureAttachment',
        'withLiteratureAttachmentRemoval',
        'listLegacyProjectSessionTombstones',
        'loadAll',
        'loadAllReadOnly',
        'loadPersistedSideChats',
        'pruneSessionEnabledComputeHosts',
        'repairProjectFiles',
        'replaceSessionMetadata',
        'sessionMetadataSnapshot'
      ],
      runManifest: ['saveManifest'],
      runProject: [
        'assertProjectArchivable',
        'completeProjectSessionDeletion',
        'deleteProjectSessions',
        'getProjectSessionDeletionState',
        'markCommittedProjectSessionsPrepared'
      ],
      runSession: [
        'adoptPublishedSession',
        'appendSideChatRelay',
        'appendUserMessageToInteraction',
        'assertSessionAvailable',
        'clearSideChat',
        'commitSideChatRelays',
        'containsMessageOnActiveBranch',
        'failTaskRun',
        'loadSessionForContinuation',
        'mutateRuntimeSession',
        'mutateSessionComputeHostAccess',
        'mutateSessionDetailsAuthority',
        'patchSessionRuntimeContext',
        'readSessionRuntimeContext',
        'readSessionSnapshot',
        'reserveSessionExport',
        'retryArtifactFinalization',
        'runSessionMutation',
        'saveSession',
        'saveSessionSpecialistBinding',
        'saveSideChatProjection',
        'setSessionComputeConcurrencyLimit',
        'settleTaskCompletion',
        'bindTaskSession',
        'prepareRuntimeResume',
        'admitTaskTurn',
        'stageTaskCompletion',
        'setSessionDelegationPolicy',
        'setSessionEnabledComputeHosts',
        'updateSessionConfiguration',
        'updateArchive'
      ],
      runSessionThenGlobalIfNeeded: ['deleteSession'],
      runSessionIdentity: ['sessionProjectId']
    }
    const expectedSchedulerRoute = new Map(
      Object.entries(schedulerRoutes).flatMap(([route, names]) =>
        names.map((name) => [name, route] as const)
      )
    )
    const asynchronousMethods = methods(facade, 'public').filter(
      (name) => name !== 'setSessionDeletionHandlers'
    )
    for (const name of asynchronousMethods) {
      const method = methodFrom(facade, name)
      if (name === 'saveSession') {
        // Export release waits outside the lane; each actual save still enters the same Session
        // scheduler. Behavioral coordinator tests cover release/retry and unrelated-lane progress.
        const calls: string[] = []
        const visit = (node: Node): void => {
          if (
            isCallExpression(node) &&
            node.expression.getText(facadeFile).startsWith('this.operationScheduler.')
          )
            calls.push(node.expression.getText(facadeFile))
          forEachChild(node, visit)
        }
        visit(method)
        expect(calls).toEqual(['this.operationScheduler.runSession'])
        continue
      }
      expect(method.body?.statements, name).toHaveLength(1)
      const statement = method.body?.statements[0]
      expect(statement, name).toBeDefined()
      if (!statement) continue
      expect(isReturnStatement(statement), name).toBe(true)
      if (!isReturnStatement(statement) || !statement.expression) continue
      expect(isCallExpression(statement.expression), name).toBe(true)
      if (!isCallExpression(statement.expression)) continue
      const target = statement.expression.expression
      expect(isPropertyAccessExpression(target), name).toBe(true)
      if (!isPropertyAccessExpression(target)) continue
      const owner = target.expression
      expect(isPropertyAccessExpression(owner), name).toBe(true)
      if (!isPropertyAccessExpression(owner)) continue
      expect(owner.expression.kind, name).toBe(SyntaxKind.ThisKeyword)
      const schedulerRoute = expectedSchedulerRoute.get(name)
      if (schedulerRoute) {
        expect(owner.name.text, name).toBe('operationScheduler')
        expect(target.name.text, name).toBe(schedulerRoute)
      } else {
        expect(owner.name.text, name).toBe('delegatedWorkOwner')
      }
    }

    for (const owner of [
      stateOwner,
      deletionOwner,
      reconciliationOwner,
      sideChatOwner,
      messageDeliveryOwner,
      delegatedWorkOwner,
      delegatedWorkStore,
      delegatedQuestionOwner
    ]) {
      expect(fields(owner)).not.toContain('queue')
      expect(methods(owner, 'public')).not.toContain('enqueue')
      expect(methods(owner, 'private')).not.toContain('enqueue')
    }

    expect(expectedSchedulerRoute.size).toBe(49)
    const constructorSource = facade.members.filter(isConstructorDeclaration)[0].getText(facadeFile)
    expect(constructorSource).toContain('this.operationScheduler.runSession(')
    expect(constructorSource).toContain('this.operationScheduler.runGlobal(work)')
  })

  it('closes the destructive startup window before awaiting and never reopens it', () => {
    const field = facade.members.find(
      (member) =>
        isPropertyDeclaration(member) && memberName(member.name) === 'destructiveStartupWindowOpen'
    )
    expect(field && isPropertyDeclaration(field) ? field.initializer?.kind : undefined).toBe(
      SyntaxKind.TrueKeyword
    )

    const assignments = walk(
      facade,
      (node) =>
        isBinaryExpression(node) &&
        node.operatorToken.kind === SyntaxKind.EqualsToken &&
        isPropertyAccessExpression(node.left) &&
        node.left.expression.kind === SyntaxKind.ThisKeyword &&
        node.left.name.text === 'destructiveStartupWindowOpen'
    ).filter(isBinaryExpression)
    expect(assignments).toHaveLength(2)
    expect(
      assignments.every((assignment) => assignment.right.kind === SyntaxKind.FalseKeyword)
    ).toBe(true)

    for (const name of ['loadAllReadOnly', 'loadAll']) {
      const method = methodFrom(facade, name)
      const assignment = assignments.find(
        (candidate) => candidate.pos >= method.pos && candidate.end <= method.end
      )
      const firstAwait = walk(method, isAwaitExpression)[0]
      expect(assignment, name).toBeDefined()
      expect(firstAwait, name).toBeDefined()
      expect(assignment!.pos, name).toBeLessThan(firstAwait.pos)
    }

    expect(calledOwnerMethods(methodFrom(facade, 'loadAllReadOnly'))).toEqual([
      'stateOwner.beginHydration',
      'stateOwner.replaceMetadata'
    ])
    const loadAll = methodFrom(facade, 'loadAll')
    expect(
      calledOwnerMethods(loadAll).filter(
        (call) => call === 'reconciliationOwner.reconcileLoadedSessions'
      )
    ).toHaveLength(1)
    const gateCapture = walk(
      loadAll,
      (node) =>
        isVariableDeclaration(node) &&
        isIdentifier(node.name) &&
        node.name.text === 'mayRunDestructiveStartupCleanup' &&
        node.initializer !== undefined &&
        isPropertyAccessExpression(node.initializer) &&
        node.initializer.expression.kind === SyntaxKind.ThisKeyword &&
        node.initializer.name.text === 'destructiveStartupWindowOpen'
    )[0]
    const cleanupOption = walk(
      loadAll,
      (node) =>
        isPropertyAssignment(node) &&
        memberName(node.name) === 'allowDestructiveCleanup' &&
        isIdentifier(node.initializer) &&
        node.initializer.text === 'mayRunDestructiveStartupCleanup'
    )[0]
    const loadAllAssignment = assignments.find(
      (candidate) => candidate.pos >= loadAll.pos && candidate.end <= loadAll.end
    )
    expect(gateCapture).toBeDefined()
    expect(cleanupOption).toBeDefined()
    expect(gateCapture.pos).toBeLessThan(loadAllAssignment!.pos)
    expect(loadAllAssignment!.pos).toBeLessThan(cleanupOption.pos)
    expect(sources.get('reconciliation-owner.ts')).not.toContain('markMetadataIncomplete')
    expect(sources.get('reconciliation-owner.ts')).not.toContain('markReconciliationIncomplete')
  })

  it('keeps tombstones in the coordinator and mutates them only in deletion workflows', () => {
    const mutationSites = new Map<string, string[]>()
    for (const tombstone of ['deletedProjects', 'deletedSessions']) mutationSites.set(tombstone, [])
    const usages = walk(
      facade,
      (node) =>
        isPropertyAccessExpression(node) &&
        node.expression.kind === SyntaxKind.ThisKeyword &&
        mutationSites.has(node.name.text)
    ).filter(isPropertyAccessExpression)
    for (const usage of usages) {
      const operation = usage.parent
      const call = operation.parent
      expect(isPropertyAccessExpression(operation) && operation.expression === usage).toBe(true)
      expect(isCallExpression(call) && call.expression === operation).toBe(true)
      if (!isPropertyAccessExpression(operation) || !isCallExpression(call)) continue
      expect(['add', 'delete', 'has']).toContain(operation.name.text)
      if (!['add', 'delete'].includes(operation.name.text)) continue
      let current: Node | undefined = call.parent
      while (current && !isMethodDeclaration(current)) current = current.parent
      expect(current && isMethodDeclaration(current)).toBe(true)
      if (!current || !isMethodDeclaration(current)) continue
      mutationSites.get(usage.name.text)!.push(`${memberName(current.name)}:${operation.name.text}`)
    }
    expect(mutationSites.get('deletedProjects')?.sort()).toEqual([
      'deleteProjectSessions:add',
      'deleteProjectSessions:delete'
    ])
    expect(mutationSites.get('deletedSessions')?.sort()).toEqual([
      'deleteSession:add',
      'deleteSession:delete'
    ])
    for (const file of [
      'state-owner.ts',
      'deletion-owner.ts',
      'message-delivery-owner.ts',
      'reconciliation-owner.ts',
      'message-delivery-owner.ts',
      'side-chat-owner.ts'
    ] as const) {
      expect(sources.get(file), file).not.toMatch(/deletedProjects|deletedSessions/)
    }
  })

  it('keeps owner interfaces narrow and facade routes explicit', () => {
    expect(methods(stateOwner, 'public')).toEqual(
      [
        'appendUserMessage',
        'beginHydration',
        'containsMessageOnActiveBranch',
        'failTaskRun',
        'invalidateBindingTopology',
        'markMetadataIncomplete',
        'metadataSnapshot',
        'mutateRuntimeSession',
        'patchRuntimeContext',
        'pruneEnabledComputeHosts',
        'readRuntimeContext',
        'recordSession',
        'removeProject',
        'removeSession',
        'replaceMetadata',
        'replaceProjectMetadata',
        'saveSession',
        'saveSessionSpecialistBinding',
        'sessionProjectId',
        'setComputeConcurrencyLimit',
        'setDelegationPolicy',
        'setEnabledComputeHosts',
        'settleTaskCompletion',
        'bindTaskSession',
        'prepareRuntimeResume',
        'admitTaskTurn',
        'stageTaskCompletion',
        'updateSessionConfiguration'
      ].sort()
    )
    expect(methods(stateOwner, 'private')).toEqual(
      [
        'loadRuntimeContextSession',
        'loadTaskRunAuthority',
        'persistTaskSession',
        'persistTaskTerminalState',
        'saveSessionWithAuthority'
      ].sort()
    )
    expect(methods(deletionOwner, 'public')).toEqual(
      [
        'assertProjectArchivable',
        'assertSessionAvailable',
        'completeProjectSessionDeletion',
        'deleteProjectSessions',
        'deleteSession',
        'getProjectSessionDeletionState',
        'listLegacyProjectSessionTombstones',
        'markCommittedProjectSessionsPrepared',
        'reconcileProjectSessionDeletion',
        'reconcileSessionDeletion',
        'updateArchive'
      ].sort()
    )
    expect(methods(deletionOwner, 'private')).toEqual(
      [
        'prepareProjectSessionUploadsForTerminalDelete',
        'prepareSessionUploadsForTerminalDelete'
      ].sort()
    )
    expect(methods(reconciliationOwner, 'public')).toEqual(
      ['reconcileLoadedSessions', 'repairFileProjection', 'retryArtifactFinalization'].sort()
    )
    expect(methods(reconciliationOwner, 'private')).toEqual([])
    expect(methods(sideChatOwner, 'public')).toEqual(
      ['appendRelay', 'clear', 'commitRelays', 'loadCatalog', 'saveProjection'].sort()
    )
    expect(methods(sideChatOwner, 'private')).toEqual(
      ['loadMutable', 'requireSideChat', 'save'].sort()
    )
    expect(methods(messageDeliveryOwner, 'public')).toEqual(
      [
        'acknowledge',
        'admit',
        'completeChildTurn',
        'settle',
        'startChildTurn',
        'startDispatch'
      ].sort()
    )
    expect(methods(messageDeliveryOwner, 'private')).toEqual(['assertWritable'])

    const expectedCalls: Record<string, string[]> = {
      acknowledgeUncertainMessage: ['delegatedWorkOwner.acknowledgeUncertainMessage'],
      admitMessageCommand: ['delegatedWorkOwner.admitMessageCommand'],
      admitQuestion: ['delegatedWorkOwner.admitQuestion'],
      appendSideChatRelay: ['sideChatOwner.appendRelay'],
      appendUserMessageToInteraction: ['stateOwner.appendUserMessage'],
      assertProjectArchivable: ['deletionOwner.assertProjectArchivable'],
      assertSessionAvailable: ['deletionOwner.assertSessionAvailable'],
      clearSideChat: ['sideChatOwner.clear'],
      commitSideChatRelays: ['sideChatOwner.commitRelays'],
      completeProjectSessionDeletion: ['deletionOwner.completeProjectSessionDeletion'],
      completeChildTurn: ['delegatedWorkOwner.completeChildTurn'],
      confirmQuestion: ['delegatedWorkOwner.confirmQuestion'],
      createChildren: ['delegatedWorkOwner.createChildren'],
      containsMessageOnActiveBranch: ['stateOwner.containsMessageOnActiveBranch'],
      deleteProjectSessions: [
        'deletionOwner.deleteProjectSessions',
        'deletionOwner.getProjectSessionDeletionState'
      ],
      deleteSession: [
        'deletionOwner.deleteSession',
        'deletionOwner.reconcileProjectSessionDeletion',
        'deletionOwner.reconcileSessionDeletion',
        'stateOwner.metadataSnapshot'
      ],
      failTaskRun: ['stateOwner.failTaskRun'],
      getProjectSessionDeletionState: ['deletionOwner.getProjectSessionDeletionState'],
      listLegacyProjectSessionTombstones: ['deletionOwner.listLegacyProjectSessionTombstones'],
      loadPersistedSideChats: ['sideChatOwner.loadCatalog'],
      markCommittedProjectSessionsPrepared: ['deletionOwner.markCommittedProjectSessionsPrepared'],
      mutateSessionComputeHostAccess: ['stateOwner.setEnabledComputeHosts'],
      patchSessionRuntimeContext: ['stateOwner.patchRuntimeContext'],
      pruneSessionEnabledComputeHosts: ['stateOwner.pruneEnabledComputeHosts'],
      readSessionRuntimeContext: ['stateOwner.readRuntimeContext'],
      replaceSessionMetadata: ['stateOwner.replaceMetadata'],
      saveSession: ['stateOwner.saveSession'],
      saveSessionSpecialistBinding: ['stateOwner.saveSessionSpecialistBinding'],
      saveSideChatProjection: ['sideChatOwner.saveProjection'],
      sessionMetadataSnapshot: ['stateOwner.metadataSnapshot'],
      sessionProjectId: ['stateOwner.sessionProjectId'],
      setSessionComputeConcurrencyLimit: ['stateOwner.setComputeConcurrencyLimit'],
      setSessionDelegationPolicy: ['stateOwner.setDelegationPolicy'],
      setSessionEnabledComputeHosts: ['stateOwner.setEnabledComputeHosts'],
      readChildren: ['delegatedWorkOwner.readChildren'],
      recoverInterruptedDelegatedWork: ['delegatedWorkOwner.recoverInterruptedDelegatedWork'],
      settleMessage: ['delegatedWorkOwner.settleMessage'],
      settleTaskCompletion: ['stateOwner.settleTaskCompletion'],
      bindTaskSession: ['stateOwner.bindTaskSession'],
      prepareRuntimeResume: ['stateOwner.prepareRuntimeResume'],
      admitTaskTurn: ['stateOwner.admitTaskTurn'],
      stageTaskCompletion: ['stateOwner.stageTaskCompletion'],
      startMessageDispatch: ['delegatedWorkOwner.startMessageDispatch'],
      startPendingMessageTurn: ['delegatedWorkOwner.startPendingMessageTurn'],
      updateArchive: ['deletionOwner.updateArchive']
    }
    for (const [method, calls] of Object.entries(expectedCalls)) {
      expect(calledOwnerMethods(methodFrom(facade, method)), method).toEqual(calls)
    }
    expect(calledOwnerMethods(methodFrom(facade, 'repairProjectFiles'))).toEqual([
      'reconciliationOwner.repairFileProjection'
    ])
  })

  it('keeps owner dependencies one-way and free of coordinator back-edges', () => {
    expect(sessionDependencies('coordinator.ts')).toEqual(
      [
        'deletion-owner.ts',
        'delegated-work-owner.ts',
        'reconciliation-owner.ts',
        'session-details-authority.ts',
        'side-chat-owner.ts',
        'state-owner.ts'
      ].sort()
    )
    expect(sessionDependencies('state-owner.ts')).toEqual(['relay-projection.ts'])
    expect(sessionDependencies('deletion-owner.ts')).toEqual(
      ['legacy-upload.ts', 'state-owner.ts'].sort()
    )
    expect(sessionDependencies('reconciliation-owner.ts')).toEqual(['legacy-upload.ts'])
    expect(sessionDependencies('session-details-authority.ts')).toEqual([])
    expect(sessionDependencies('side-chat-owner.ts')).toEqual([])
    expect(sessionDependencies('message-delivery-owner.ts')).toEqual([])
    expect(sessionDependencies('delegated-question-owner.ts')).toEqual(
      ['delegated-work-store.ts', 'message-delivery-owner.ts'].sort()
    )
    expect(sessionDependencies('delegated-work-owner.ts')).toEqual(
      ['delegated-question-owner.ts', 'delegated-work-store.ts', 'message-delivery-owner.ts'].sort()
    )
    expect(sessionDependencies('delegated-work-store.ts')).toEqual(['state-owner.ts'])
    for (const file of [
      'state-owner.ts',
      'delegated-question-owner.ts',
      'delegated-work-owner.ts',
      'delegated-work-store.ts',
      'deletion-owner.ts',
      'message-delivery-owner.ts',
      'reconciliation-owner.ts',
      'relay-projection.ts',
      'side-chat-owner.ts'
    ] as const) {
      expect(sessionDependencies(file), file).not.toContain('coordinator.ts')
    }
  })

  it('keeps the module-impact manifest closed over owners and certification tests', () => {
    const manifest = loadModuleImpactManifest(resolve(projectRoot, 'scripts/ci/module-impact.json'))
    const sessionPersistence = manifest.modules.session_persistence

    expect(sessionPersistence.ownerPaths).toEqual([
      'src/main/session-persistence/coordinator.ts',
      'src/main/session-persistence/delegated-question-owner.ts',
      'src/main/session-persistence/delegated-work-owner.ts',
      'src/main/session-persistence/delegated-work-store.ts',
      'src/main/session-persistence/deletion-owner.ts',
      'src/main/session-persistence/legacy-upload.ts',
      'src/main/session-persistence/message-delivery-owner.ts',
      'src/main/session-persistence/reconciliation-owner.ts',
      'src/main/session-persistence/relay-projection.ts',
      'src/main/session-persistence/session-details-authority.ts',
      'src/main/session-persistence/side-chat-owner.ts',
      'src/main/session-persistence/state-owner.ts',
      'src/main/session-persistence/application-command-errors.ts',
      'src/main/session-persistence/artifact-alias-repair.test.ts',
      'src/main/session-persistence/artifact-alias-repair.ts',
      'src/main/session-persistence/artifact-finalization-recovery.integration.test.ts',
      'src/main/session-persistence/auxiliary-turn-usage.test.ts',
      'src/main/session-persistence/auxiliary-turn-usage.ts',
      'src/main/session-persistence/catalog-authority.ts',
      'src/main/session-persistence/claude-replay.test.ts',
      'src/main/session-persistence/claude-replay.ts',
      'src/main/session-persistence/compute-policy.test.ts',
      'src/main/session-persistence/compute-policy.ts',
      'src/main/session-persistence/conversation-export.test.ts',
      'src/main/session-persistence/conversation-export.ts',
      'src/main/session-persistence/coordinator-contract.test.ts',
      'src/main/session-persistence/coordinator.architecture.test.ts',
      'src/main/session-persistence/coordinator.test.ts',
      'src/main/session-persistence/data-path-roundtrip.test.ts',
      'src/main/session-persistence/delegated-work-records.test.ts',
      'src/main/session-persistence/deletion-integration.test.ts',
      'src/main/session-persistence/imported-session.test.ts',
      'src/main/session-persistence/imported-session.ts',
      'src/main/session-persistence/ipc.test.ts',
      'src/main/session-persistence/ipc.ts',
      'src/main/session-persistence/literature-attachment-removal.ts',
      'src/main/session-persistence/message-attribution-authority.ts',
      'src/main/session-persistence/message-search.test.ts',
      'src/main/session-persistence/message-search.ts',
      'src/main/session-persistence/operation-scheduler.test.ts',
      'src/main/session-persistence/operation-scheduler.ts',
      'src/main/session-persistence/paths.ts',
      'src/main/session-persistence/pdf-context-link-workflow.test.ts',
      'src/main/session-persistence/pdf-context-link-workflow.ts',
      'src/main/session-persistence/pdf-context-owner.test.ts',
      'src/main/session-persistence/pdf-context-owner.ts',
      'src/main/session-persistence/projection-diagnostics.test.ts',
      'src/main/session-persistence/projection-diagnostics.ts',
      'src/main/session-persistence/projection.test.ts',
      'src/main/session-persistence/projection.ts',
      'src/main/session-persistence/renderer-flush.test.ts',
      'src/main/session-persistence/renderer-flush.ts',
      'src/main/session-persistence/renderer-save-options.test.ts',
      'src/main/session-persistence/renderer-save-options.ts',
      'src/main/session-persistence/repository-queue.test.ts',
      'src/main/session-persistence/repository.test.ts',
      'src/main/session-persistence/repository.ts',
      'src/main/session-persistence/revision-conflict.test.ts',
      'src/main/session-persistence/revision-conflict.ts',
      'src/main/session-persistence/runtime-lookup.test.ts',
      'src/main/session-persistence/runtime-lookup.ts',
      'src/main/session-persistence/save-session.test.ts',
      'src/main/session-persistence/save-session.ts',
      'src/main/session-persistence/session-data-paths.ts',
      'src/main/session-persistence/session-update-publication.ts',
      'src/main/session-persistence/task-admission.ts',
      'src/main/session-persistence/usage-regressions.test.ts',
      'src/main/session-persistence/runtime-authority.test.ts',
      'src/main/session-persistence/runtime-session-owner.test.ts',
      'src/main/session-persistence/runtime-session-owner.ts',
      'src/main/session-persistence/runtime-writer.test.ts',
      'src/main/session-persistence/runtime-writer.ts',
      'src/main/session-persistence/runtime-resume-recovery.test.ts',
      'src/main/session-persistence/resumed-artifact-publication.integration.test.ts'
    ])
    expect(sessionPersistence.interfacePaths).toEqual([
      'src/main/session-persistence/coordinator.ts',
      'src/main/session-persistence/application-command-errors.ts',
      'src/main/session-persistence/auxiliary-turn-usage.ts',
      'src/main/session-persistence/catalog-authority.ts',
      'src/main/session-persistence/claude-replay.ts',
      'src/main/session-persistence/compute-policy.ts',
      'src/main/session-persistence/conversation-export.ts',
      'src/main/session-persistence/deletion-owner.ts',
      'src/main/session-persistence/imported-session.ts',
      'src/main/session-persistence/ipc.ts',
      'src/main/session-persistence/message-attribution-authority.ts',
      'src/main/session-persistence/message-search.ts',
      'src/main/session-persistence/paths.ts',
      'src/main/session-persistence/pdf-context-link-workflow.ts',
      'src/main/session-persistence/pdf-context-owner.ts',
      'src/main/session-persistence/projection-diagnostics.ts',
      'src/main/session-persistence/projection.ts',
      'src/main/session-persistence/renderer-flush.ts',
      'src/main/session-persistence/repository.ts',
      'src/main/session-persistence/runtime-lookup.ts',
      'src/main/session-persistence/session-data-paths.ts',
      'src/main/session-persistence/state-owner.ts',
      'src/main/session-persistence/task-admission.ts',
      'src/main/session-persistence/runtime-session-owner.ts',
      'src/main/session-persistence/runtime-writer.ts'
    ])
    expect(sessionPersistence.consumerModules).toEqual(['project_lifecycle'])
    expect(sessionPersistence.testFiles.owner).toEqual([
      'src/main/session-persistence/coordinator.architecture.test.ts',
      'src/main/session-persistence/coordinator.test.ts',
      'src/main/session-persistence/delegated-work-records.test.ts',
      'src/main/session-persistence/artifact-alias-repair.test.ts',
      'src/main/session-persistence/auxiliary-turn-usage.test.ts',
      'src/main/session-persistence/claude-replay.test.ts',
      'src/main/session-persistence/compute-policy.test.ts',
      'src/main/session-persistence/conversation-export.test.ts',
      'src/main/session-persistence/data-path-roundtrip.test.ts',
      'src/main/session-persistence/imported-session.test.ts',
      'src/main/session-persistence/message-search.test.ts',
      'src/main/session-persistence/operation-scheduler.test.ts',
      'src/main/session-persistence/pdf-context-link-workflow.test.ts',
      'src/main/session-persistence/pdf-context-owner.test.ts',
      'src/main/session-persistence/projection-diagnostics.test.ts',
      'src/main/session-persistence/projection.test.ts',
      'src/main/session-persistence/renderer-flush.test.ts',
      'src/main/session-persistence/renderer-save-options.test.ts',
      'src/main/session-persistence/repository-queue.test.ts',
      'src/main/session-persistence/repository.test.ts',
      'src/main/session-persistence/revision-conflict.test.ts',
      'src/main/session-persistence/runtime-lookup.test.ts',
      'src/main/session-persistence/save-session.test.ts',
      'src/main/session-persistence/usage-regressions.test.ts',
      'src/main/session-persistence/runtime-authority.test.ts',
      'src/main/session-persistence/runtime-session-owner.test.ts',
      'src/main/session-persistence/runtime-writer.test.ts',
      'src/main/session-persistence/runtime-resume-recovery.test.ts',
      'src/main/session-persistence/resumed-artifact-publication.integration.test.ts'
    ])
    expect(sessionPersistence.testFiles.contract).toEqual([
      'src/shared/session-persistence.test.ts',
      'src/main/session-persistence/coordinator-contract.test.ts',
      'src/main/session-persistence/ipc.test.ts',
      'src/preload/index.test.ts',
      'src/renderer/web/api-installer.test.ts',
      'src/shared/renderer-contract-catalog.test.ts'
    ])
    expect(sessionPersistence.testFiles.consumer).toEqual([
      'src/renderer/src/lib/acp/runtime-observer.test.ts',
      'src/renderer/src/lib/acp/runtime-writer-takeover.test.ts',
      'src/main/session-plan/adversarial-session-plan.test.ts',
      'src/main/delegation/durable-delegated-work.test.ts',
      'src/main/delegation/session-record-adapter.test.ts',
      'src/main/session-persistence/artifact-finalization-recovery.integration.test.ts',
      'src/main/session-persistence/deletion-integration.test.ts',
      'scripts/stage-default-envs.test.ts',
      'src/main/acp/application-commands.test.ts',
      'src/main/acp/artifact-code-reconstruction-runner.test.ts',
      'src/main/acp/codex-completion-handoff.integration.test.ts',
      'src/main/acp/context-compaction-workflow.test.ts',
      'src/main/acp/context-usage-policy.test.ts',
      'src/main/acp/create-session-workflow.test.ts',
      'src/main/acp/durable-continuation-context-owner.test.ts',
      'src/main/acp/file-reference-resolver.test.ts',
      'src/main/acp/file-reference-resolver.windows-scope.test.ts',
      'src/main/acp/handler-workflows.test.ts',
      'src/main/acp/image-input-compatibility-owner.test.ts',
      'src/main/acp/ipc.test.ts',
      'src/main/acp/isolated-execution-preflight.test.ts',
      'src/main/acp/managed-session-workspace.test.ts',
      'src/main/acp/mcp-http-host.test.ts',
      'src/main/acp/native-follow-up-workflow.test.ts',
      'src/main/acp/opencode-immediate-handoff.integration.test.ts',
      'src/main/acp/opencode-immediate-handoff.test.ts',
      'src/main/acp/permission-broker-registry.test.ts',
      'src/main/acp/permission-wait-owner.test.ts',
      'src/main/acp/prompt-attachment-notebook-sandbox.integration.test.ts',
      'src/main/acp/prompt-content-owner.test.ts',
      'src/main/acp/prompt-image-privacy.test.ts',
      'src/main/acp/prompt-outcome-finalizer.test.ts',
      'src/main/acp/prompt-preparation-owner.test.ts',
      'src/main/acp/prompt-turn-workflow.test.ts',
      'src/main/acp/provider-prompt-executor.test.ts',
      'src/main/acp/provider-session-adopter.test.ts',
      'src/main/acp/provider-session-creator.test.ts',
      'src/main/acp/provider-session-resumer.test.ts',
      'src/main/acp/restricted-inference-runner.test.ts',
      'src/main/acp/runtime-activity.test.ts',
      'src/main/acp/runtime-base-composition.test.ts',
      'src/main/acp/runtime-composition.test.ts',
      'src/main/acp/runtime-coordinator.test.ts',
      'src/main/acp/runtime-library-evidence.test.ts',
      'src/main/acp/runtime-lifecycle-composition.test.ts',
      'src/main/acp/runtime-pdf-elements.test.ts',
      'src/main/acp/runtime-plan-composition.test.ts',
      'src/main/acp/runtime-prompt-composition.test.ts',
      'src/main/acp/runtime-provider-session-composition.test.ts',
      'src/main/acp/runtime-session-composition.test.ts',
      'src/main/acp/runtime-session-plan.test.ts',
      'src/main/acp/runtime.test.ts',
      'src/main/acp/session-capability-handover.integration.test.ts',
      'src/main/acp/session-capability-owner.test.ts',
      'src/main/acp/session-deletion-workflow.test.ts',
      'src/main/acp/session-environment-policy.test.ts',
      'src/main/acp/session-plan-delivery-owner.test.ts',
      'src/main/acp/session-presentation-policy.test.ts',
      'src/main/acp/session-replacement-workflow.test.ts',
      'src/main/acp/session-update-projector.test.ts',
      'src/main/acp/shutdown-guard.test.ts',
      'src/main/acp/side-chat-interaction-admission.test.ts',
      'src/main/acp/task-agent-port.test.ts',
      'src/main/acp/turn-skill-owner.test.ts',
      'src/main/agents/agents-repl.integration.test.ts',
      'src/main/agents/agents-repl.mutations.integration.test.ts',
      'src/main/agents/agents-repl.privileged.integration.test.ts',
      'src/main/agents/agents-repl.runtime-consumption.integration.test.ts',
      'src/main/agents/app-handoff-runtime.integration.test.ts',
      'src/main/agents/completion-gate.execute-control.integration.test.ts',
      'src/main/agents/completion-gate.integration.test.ts',
      'src/main/app-lifecycle.test.ts',
      'src/main/app-startup.test.ts',
      'src/main/application-command-client.test.ts',
      'src/main/application-command-composition.test.ts',
      'src/main/application-command-electron-adapter.test.ts',
      'src/main/application-event-flow.test.ts',
      'src/main/artifacts/artifact-provenance-graph.test.ts',
      'src/main/artifacts/artifact-reproducibility-execution.test.ts',
      'src/main/artifacts/artifact-reproducibility-export.test.ts',
      'src/main/artifacts/ro-crate-export.test.ts',
      'src/main/artifacts/artifact-reproducibility-ipc.test.ts',
      'src/main/artifacts/artifact-reproducibility-lifecycle.test.ts',
      'src/main/artifacts/artifact-reproducibility-receipts.test.ts',
      'src/main/artifacts/artifact-reproducibility-recipe.test.ts',
      'src/main/artifacts/artifact-save.integration.test.ts',
      'src/main/artifacts/code-reconstruction.test.ts',
      'src/main/artifacts/ipc.test.ts',
      'src/main/artifacts/literature-manifest.test.ts',
      'src/main/artifacts/mcp-server.test.ts',
      'src/main/artifacts/provenance-analysis-revision.test.ts',
      'src/main/artifacts/provenance-dependency-read.test.ts',
      'src/main/artifacts/provenance-helper-evidence.test.ts',
      'src/main/artifacts/provenance-lifecycle-contract.test.ts',
      'src/main/artifacts/provenance-message-snapshot.test.ts',
      'src/main/artifacts/provenance-repository.test.ts',
      'src/main/artifacts/provenance-snapshot-decoder.test.ts',
      'src/main/artifacts/provenance-startup.integration.test.ts',
      'src/main/artifacts/provenance-write-contract.test.ts',
      'src/main/bookmarks/pdf-source-diagnostics.test.ts',
      'src/main/bookmarks/repository.integration.test.ts',
      'src/main/bookmarks/service.test.ts',
      'src/main/compute/agent-compute-service.test.ts',
      'src/main/compute/ambiguous-dispatch-recovery.integration.test.ts',
      'src/main/compute/application-commands.test.ts',
      'src/main/compute/compute-job-cancellation-owner.integration.test.ts',
      'src/main/compute/compute-job-workflow-owner.test.ts',
      'src/main/compute/compute-jobs.integration.test.ts',
      'src/main/compute/compute-password-auth.real-ssh.integration.test.ts',
      'src/main/compute/compute-password-auth.release.test.ts',
      'src/main/compute/compute-service.test.ts',
      'src/main/compute/concurrency-integration.test.ts',
      'src/main/compute/concurrency-manager.test.ts',
      'src/main/compute/ipc.test.ts',
      'src/main/compute/job-deletion-owner.test.ts',
      'src/main/compute/job-deletion-runtime-drain.test.ts',
      'src/main/compute/job-deletion-runtime-isolation.test.ts',
      'src/main/compute/job-dispatcher.test.ts',
      'src/main/compute/job-notifier.integration.test.ts',
      'src/main/compute/job-poll-protocol.integration.test.ts',
      'src/main/compute/job-poller.test.ts',
      'src/main/compute/job-recovery-regressions.integration.test.ts',
      'src/main/compute/job-repository.test.ts',
      'src/main/compute/job-runtime.test.ts',
      'src/main/compute/session-catalog-hydration.integration.test.ts',
      'src/main/compute/session-enabled-hosts-owner.test.ts',
      'src/main/compute/skill-provisioning.test.ts',
      'src/main/compute/slurm.real-ssh.integration.test.ts',
      'src/main/compute/ssh-runner.test.ts',
      'src/main/connectors/application.test.ts',
      'src/main/data-content-application-commands.test.ts',
      'src/main/database/literature-inbox-integrity-migration.test.ts',
      'src/main/database/managed-file-version-domain.test.ts',
      'src/main/database/migration-service.test.ts',
      'src/main/delegation/production-composition.test.ts',
      'src/main/delegation/production-framework-runtime.test.ts',
      'src/main/host-application-commands.test.ts',
      'src/main/immutable-input-authority.test.ts',
      'src/main/index-fatal-errors.test.ts',
      'src/main/index-startup-failure.test.ts',
      'src/main/ipc-surfaces/adapter.test.ts',
      'src/main/ipc-surfaces/artifacts.test.ts',
      'src/main/ipc-surfaces/connector-approvals.test.ts',
      'src/main/ipc-surfaces/core.test.ts',
      'src/main/ipc-surfaces/desktop-utilities.test.ts',
      'src/main/ipc-surfaces/notifications.test.ts',
      'src/main/ipc-surfaces/office-preview.test.ts',
      'src/main/ipc-surfaces/session-persistence.test.ts',
      'src/main/ipc-surfaces/settings.test.ts',
      'src/main/ipc-surfaces/specialist.test.ts',
      'src/main/ipc-surfaces/uploads.test.ts',
      'src/main/literature/agent-pdf-acquisition.test.ts',
      'src/main/literature/attachment-authority.test.ts',
      'src/main/literature/batch-jobs.test.ts',
      'src/main/literature/catalog-capacity.test.ts',
      'src/main/literature/catalog.test.ts',
      'src/main/literature/document-reader.test.ts',
      'src/main/literature/export-roundtrip.test.ts',
      'src/main/literature/full-text-finder.test.ts',
      'src/main/literature/library-mcp-server.test.ts',
      'src/main/literature/library-tool-contracts.test.ts',
      'src/main/literature/mcp-server.test.ts',
      'src/main/literature/metadata-enricher.test.ts',
      'src/main/literature/migration-writers.test.ts',
      'src/main/literature/pdf-attachment-reliability.test.ts',
      'src/main/literature/pdf-elements-mcp.test.ts',
      'src/main/literature/pdf-importer.test.ts',
      'src/main/literature/pdf-structure/agent-reader.test.ts',
      'src/main/literature/pdf-structure/engine.test.ts',
      'src/main/literature/pdf-structure/owner.test.ts',
      'src/main/literature/pdf-structure/reader.test.ts',
      'src/main/literature/pdf-structure/source-metadata.test.ts',
      'src/main/literature/reference-resolver.test.ts',
      'src/main/literature/scale-regressions.test.ts',
      'src/main/literature/session-pdf-source-resolver.test.ts',
      'src/main/local-models/owner.test.ts',
      'src/main/managed-file-versions/diff-task.test.ts',
      'src/main/managed-file-versions/ipc.test.ts',
      'src/main/managed-file-versions/service.integration.test.ts',
      'src/main/managed-preview-ipc.test.ts',
      'src/main/managed-preview-protocol.test.ts',
      'src/main/managed-preview-resources.test.ts',
      'src/main/notebook/application-commands.test.ts',
      'src/main/notebook/application.test.ts',
      'src/main/notebook/bundle-local.test.ts',
      'src/main/notebook/cell-execution-input.test.ts',
      'src/main/notebook/cross-turn-input-repro.integration.test.ts',
      'src/main/notebook/delegated-lane-capability.test.ts',
      'src/main/notebook/dependency-analysis.r-plot-repro.test.ts',
      'src/main/notebook/e2e.certification.test.ts',
      'src/main/notebook/env-ipc.test.ts',
      'src/main/notebook/environment-lifecycle-workflows.test.ts',
      'src/main/notebook/environment-lock.test.ts',
      'src/main/notebook/environment-management.test.ts',
      'src/main/notebook/environment-operation-foundation.test.ts',
      'src/main/notebook/environment-state-tracker.test.ts',
      'src/main/notebook/external-environment-lock.test.ts',
      'src/main/notebook/external-r-library.test.ts',
      'src/main/notebook/full-stack.smoke.test.ts',
      'src/main/notebook/host-artifacts-service.test.ts',
      'src/main/notebook/host-compute.integration.test.ts',
      'src/main/notebook/host-mcp.integration.test.ts',
      'src/main/notebook/host-model-service.test.ts',
      'src/main/notebook/input-registry.test.ts',
      'src/main/notebook/ipc.test.ts',
      'src/main/notebook/kernel-executor.test.ts',
      'src/main/notebook/kernel-startup-retry.integration.test.ts',
      'src/main/notebook/language-pack-fetch.test.ts',
      'src/main/notebook/local-rpc-notebook-adapter.test.ts',
      'src/main/notebook/local-rpc-server.agents.test.ts',
      'src/main/notebook/local-rpc-server.artifacts.test.ts',
      'src/main/notebook/local-rpc-server.capabilities.test.ts',
      'src/main/notebook/local-rpc-server.delegated-work.test.ts',
      'src/main/notebook/local-rpc-server.errors.test.ts',
      'src/main/notebook/local-rpc-server.frames.test.ts',
      'src/main/notebook/local-rpc-server.lineage.test.ts',
      'src/main/notebook/local-rpc-server.llm.test.ts',
      'src/main/notebook/local-rpc-server.mcpcall.test.ts',
      'src/main/notebook/local-rpc-server.models.test.ts',
      'src/main/notebook/local-rpc-server.sessions.test.ts',
      'src/main/notebook/local-rpc-server.skill-import.test.ts',
      'src/main/notebook/local-rpc-server.skills.test.ts',
      'src/main/notebook/local-rpc-server.test.ts',
      'src/main/notebook/local-rpc-server.user-input.test.ts',
      'src/main/notebook/local-rpc-server.wsl-setup.test.ts',
      'src/main/notebook/mcp-management-lifecycle.integration.test.ts',
      'src/main/notebook/mcp-server.test.ts',
      'src/main/notebook/micromamba.test.ts',
      'src/main/notebook/native-lock-restoration.test.ts',
      'src/main/notebook/native-shell-certification.macos.integration.test.ts',
      'src/main/notebook/network-sandbox-owner.macos-isolation.integration.test.ts',
      'src/main/notebook/network-sandbox-owner.test.ts',
      'src/main/notebook/no-legacy-bridge.test.ts',
      'src/main/notebook/package-admission.test.ts',
      'src/main/notebook/package-cache-sandbox.integration.test.ts',
      'src/main/notebook/package-listing.test.ts',
      'src/main/notebook/package-manager.test.ts',
      'src/main/notebook/package-mutation.test.ts',
      'src/main/notebook/package-operations.test.ts',
      'src/main/notebook/package-process-sandbox.test.ts',
      'src/main/notebook/package-process-sandbox.windows.integration.test.ts',
      'src/main/notebook/pip-install-evidence.test.ts',
      'src/main/notebook/pip-wheel-evidence.test.ts',
      'src/main/notebook/process-tree-consumers.macos.integration.test.ts',
      'src/main/notebook/provisioner.startup.test.ts',
      'src/main/notebook/provisioner.test.ts',
      'src/main/notebook/provisioner.upgrade.test.ts',
      'src/main/notebook/recovery-coordinator.test.ts',
      'src/main/notebook/repl-loop.integration.test.ts',
      'src/main/notebook/reproduction-runtime.integration.test.ts',
      'src/main/notebook/reproduction-runtime.test.ts',
      'src/main/notebook/restored-environment-verification.test.ts',
      'src/main/notebook/run-document-data-paths.test.ts',
      'src/main/notebook/runtime-application-commands.test.ts',
      'src/main/notebook/runtime-ipc.test.ts',
      'src/main/notebook/runtime-relocation.test.ts',
      'src/main/notebook/runtime-repair.test.ts',
      'src/main/notebook/runtime-service-logging.integration.test.ts',
      'src/main/notebook/runtime-service.export.test.ts',
      'src/main/notebook/runtime-service.macos-isolation.integration.test.ts',
      'src/main/notebook/runtime-service.rpc-retirement.test.ts',
      'src/main/notebook/runtime-service.test.ts',
      'src/main/notebook/runtime-workflows.test.ts',
      'src/main/notebook/windows-external-r.integration.test.ts',
      'src/main/notebook/windows-first-r-access.integration.test.ts',
      'src/main/notebook/windows-micromamba-runner.test.ts',
      'src/main/notebook/windows-path-access.integration.test.ts',
      'src/main/notebook/windows-r-conda-discovery.integration.test.ts',
      'src/main/notebook/windows-repl-termination.integration.test.ts',
      'src/main/notebook/windows-shell.integration.test.ts',
      'src/main/notebook/working-file-observer.test.ts',
      'src/main/notebook/wsl-setup-powershell.integration.test.ts',
      'src/main/notebook/wsl2-shell.integration.test.ts',
      'src/main/notifications/notification-inbox-runtime.test.ts',
      'src/main/office-preview/office-preview-ipc-lifecycle.test.ts',
      'src/main/office-preview/office-preview-ipc.test.ts',
      'src/main/office-preview/office-preview-navigation.test.ts',
      'src/main/office-preview/office-preview-oopif-supervisor.test.ts',
      'src/main/permission-grants/application-commands.test.ts',
      'src/main/permission-grants/ipc.test.ts',
      'src/main/permission-grants/projection-controller.test.ts',
      'src/main/permission-grants/registry.test.ts',
      'src/main/project-files/content-search.test.ts',
      'src/main/project-files/host-artifact-catalog.test.ts',
      'src/main/project-files/ipc.test.ts',
      'src/main/project-files/repository.test.ts',
      'src/main/projects/data-lifecycle-regressions.integration.test.ts',
      'src/main/projects/deletion-coordinator.test.ts',
      'src/main/projects/ipc.test.ts',
      'src/main/projects/preview-repository.test.ts',
      'src/main/remote-access/ipc.test.ts',
      'src/main/remote-access/pairing.test.ts',
      'src/main/remote-access/service.test.ts',
      'src/main/reviewer/correction-context.test.ts',
      'src/main/reviewer/correction-owner.test.ts',
      'src/main/reviewer/correction.test.ts',
      'src/main/reviewer/fix-loop.test.ts',
      'src/main/reviewer/host-sdk.test.ts',
      'src/main/reviewer/image-generation-trace.integration.test.ts',
      'src/main/reviewer/ipc.test.ts',
      'src/main/reviewer/lifecycle.test.ts',
      'src/main/reviewer/log-capture.test.ts',
      'src/main/reviewer/model-runtime-owner.test.ts',
      'src/main/reviewer/orchestrator-drive.test.ts',
      'src/main/reviewer/orchestrator-prompt-prefix.test.ts',
      'src/main/reviewer/orchestrator-prompt.test.ts',
      'src/main/reviewer/orchestrator.start-contract.test.ts',
      'src/main/reviewer/orchestrator.test.ts',
      'src/main/reviewer/paged-preview-electron.test.ts',
      'src/main/reviewer/review-assessment-owner.test.ts',
      'src/main/reviewer/reviewer-fix-loop-owner.test.ts',
      'src/main/runtime-electron-wiring.test.ts',
      'src/main/runtime-state-ownership.architecture.test.ts',
      'src/main/session-package/archive.test.ts',
      'src/main/session-package/deletion.test.ts',
      'src/main/session-package/desktop-composition.test.ts',
      'src/main/session-package/desktop.test.ts',
      'src/main/session-package/export-validation.test.ts',
      'src/main/session-package/inspection-worker.integration.test.ts',
      'src/main/session-package/literature.test.ts',
      'src/main/session-package/native-snapshot.test.ts',
      'src/main/session-package/portability.test.ts',
      'src/main/session-package/recovery-diagnostics.test.ts',
      'src/main/session-package/recovery.test.ts',
      'src/main/session-package/service.test.ts',
      'src/main/session-plan/plan-service.test.ts',
      'src/main/session-plan/production-plan-service.test.ts',
      'src/main/settings/application-commands.test.ts',
      'src/main/settings/backend-resolver.test.ts',
      'src/main/settings/bootstrap.integration.test.ts',
      'src/main/settings/connector-credential-recovery.integration.test.ts',
      'src/main/settings/integration-application-commands.test.ts',
      'src/main/settings/ipc.test.ts',
      'src/main/settings/network-proxy-settings.test.ts',
      'src/main/settings/runtime-application-commands.test.ts',
      'src/main/settings/service.connectors.test.ts',
      'src/main/settings/service.providers.test.ts',
      'src/main/settings/service.test.ts',
      'src/main/settings/skill-catalog.registered-helpers.test.ts',
      'src/main/settings/workflows.test.ts',
      'src/main/settings/workflows/connectors-diagnostic.test.ts',
      'src/main/side-chat/ipc.test.ts',
      'src/main/side-chat/runtime-owner.test.ts',
      'src/main/side-chat/session-lifetime.test.ts',
      'src/main/skills/conversation-import.test.ts',
      'src/main/skills/registered-helper-catalog.test.ts',
      'src/main/specialist/application-commands.test.ts',
      'src/main/specialist/ipc.test.ts',
      'src/main/specialist/specialist-identity-injection.test.ts',
      'src/main/storage-root.test.ts',
      'src/main/storage/command-owner.atomicity.test.ts',
      'src/main/storage/content-repository.test.ts',
      'src/main/storage/data-path.test.ts',
      'src/main/storage/ipc.test.ts',
      'src/main/storage/literature-migration.integration.test.ts',
      'src/main/storage/managed-workspace-ownership.integration.test.ts',
      'src/main/storage/migration-service.test.ts',
      'src/main/storage/normalize-legacy-paths.test.ts',
      'src/main/storage/provenance-migration-validation.test.ts',
      'src/main/tasks/task-runner.test.ts',
      'src/main/update/legacy-shell-recovery.integration.test.ts',
      'src/main/uploads/caller-cancellation.test.ts',
      'src/main/uploads/command-owner.test.ts',
      'src/main/uploads/ipc.test.ts',
      'src/main/uploads/publication-lifecycle.integration.test.ts',
      'src/main/uploads/repository.characterization.test.ts',
      'src/main/uploads/repository.test.ts',
      'src/main/web-service/artifact-download.integration.test.ts',
      'src/main/web-service/controller.test.ts',
      'src/main/web-service/http-server.test.ts',
      'src/main/web-service/task-api.test.ts',
      'src/main/window-close-confirm.test.ts',
      'src/main/window-find-ipc.test.ts',
      'src/renderer/src/components/global-search/GlobalSearchDialog.test.tsx',
      'src/renderer/src/hooks/useLifecycleSync.test.tsx',
      'src/renderer/src/lib/acp/useWorkspaceAgentRuntime.test.ts',
      'src/renderer/src/lib/session-persistence/session-persistence.render.test.tsx',
      'src/renderer/src/lib/session-persistence/session-persistence.test.ts',
      'src/renderer/src/pages/literature/LiteratureFullTextLookup.render.test.tsx',
      'src/renderer/src/pages/literature/LiteratureLibraryPage.render.test.tsx',
      'src/renderer/src/pages/literature/LiteratureMetadataEditor.test.tsx',
      'src/renderer/src/pages/workspace/ArtifactProvenancePanel.render.test.tsx',
      'src/renderer/src/pages/workspace/ConversationExportDialog.interaction.test.tsx',
      'src/renderer/src/pages/workspace/artifact-publication-preview.integration.test.tsx',
      'src/renderer/src/pages/workspace/previews/preview-pagination-contract.test.tsx',
      'src/shared/renderer-surface-inventory.test.ts',
      'src/shared/renderer-surface-matrix.test.ts',
      'src/main/settings/skill-catalog.test.ts',
      'src/main/session-package/fork.test.ts',
      'src/main/storage/migration-target-race.test.ts',
      'src/renderer/src/components/LegacyDataMoveDialog.storage.test.tsx',
      'src/main/storage/brand-location.test.ts',
      'src/main/session-plan/plan-legacy-compatibility.test.ts',
      'src/main/session-plan/plan-context-file.shell.integration.test.ts',
      'src/renderer/src/pages/workspace/workspace-message-queue-controller.test.ts',
      'src/main/session-details/startup-catalog.test.ts',
      'src/renderer/src/lib/acp/workspace-runtime-interrupted-recovery.test.ts',
      'src/main/artifacts/resumed-finalization-ownership.test.ts',
      'src/main/compute/cancellation-runtime.integration.test.ts',
      'src/main/pdf-annotations/repository.integration.test.ts',
      'src/main/pdf-annotations/service.test.ts',
      'src/main/session-package/ro-crate.integration.test.ts',
      'src/main/session-package/ro-crate.test.ts',
      'src/main/settings/codex-bridge-tools.test.ts',
      'src/main/settings/backend-route-planner.test.ts',
      'src/main/settings/claude-provider-configuration.integration.test.ts',
      'src/main/settings/provider-runtime-health-owner.test.ts',
      'src/main/settings/provider-transport-owner.test.ts',
      'src/main/settings/session-details-model-owner.test.ts',
      'src/main/literature/smart-collections.test.ts',
      'src/main/settings/classification-usage.test.ts',
      'src/main/compute/compute-submission-evidence-recovery.integration.test.ts'
    ])
    expect(sessionPersistence.capabilityOverlays).toEqual([
      'windows_sensitive',
      'e2e_regressions',
      'e2e_delegation'
    ])
    expect(sessionPersistence.fallbackCapability).toBe('main_runtime')
  })
})
