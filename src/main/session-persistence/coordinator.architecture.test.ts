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

type ModuleImpactManifest = {
  modules: Record<
    string,
    {
      ownerPaths: string[]
      interfacePaths: string[]
      consumerModules: string[]
      testFiles: { owner: string[]; contract: string[]; consumer: string[] }
      capabilityOverlays: string[]
      fallbackCapability: string
    }
  >
}

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
        'mutateSessionComputeHostAccess',
        'mutateSessionDetailsAuthority',
        'patchSessionRuntimeContext',
        'pruneSessionEnabledComputeHosts',
        'readChildren',
        'readSessionRuntimeContext',
        'recoverInterruptedDelegatedWork',
        'replaceSessionMetadata',
        'repairProjectFiles',
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
      'workspaceOwnership:optional'
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
        'appendSideChatRelay',
        'appendUserMessageToInteraction',
        'assertSessionAvailable',
        'clearSideChat',
        'commitSideChatRelays',
        'containsMessageOnActiveBranch',
        'failTaskRun',
        'loadSessionForContinuation',
        'mutateSessionComputeHostAccess',
        'mutateSessionDetailsAuthority',
        'patchSessionRuntimeContext',
        'readSessionRuntimeContext',
        'retryArtifactFinalization',
        'runSessionMutation',
        'saveSession',
        'saveSessionSpecialistBinding',
        'saveSideChatProjection',
        'setSessionComputeConcurrencyLimit',
        'settleTaskCompletion',
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

    expect(expectedSchedulerRoute.size).toBe(40)
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
    const manifest = JSON.parse(
      readFileSync(resolve(projectRoot, 'scripts/ci/module-impact.json'), 'utf8')
    ) as ModuleImpactManifest
    const sessionPersistence = manifest.modules.session_persistence

    expect(sessionPersistence.ownerPaths).toEqual(
      productionFiles.map((file) => `src/main/session-persistence/${file}`)
    )
    expect(sessionPersistence.interfacePaths).toEqual([
      'src/main/session-persistence/coordinator.ts'
    ])
    expect(sessionPersistence.consumerModules).toEqual([])
    expect(sessionPersistence.testFiles.owner).toEqual([
      'src/main/session-persistence/coordinator.architecture.test.ts',
      'src/main/session-persistence/coordinator.test.ts',
      'src/main/session-persistence/delegated-work-records.test.ts'
    ])
    expect(sessionPersistence.testFiles.contract).toEqual([
      'src/shared/session-persistence.test.ts',
      'src/main/session-persistence/coordinator-contract.test.ts'
    ])
    expect(sessionPersistence.testFiles.consumer).toEqual([
      'src/main/delegation/durable-delegated-work.test.ts',
      'src/main/delegation/session-record-adapter.test.ts',
      'src/main/session-persistence/artifact-finalization-recovery.integration.test.ts',
      'src/main/session-persistence/deletion-integration.test.ts'
    ])
    expect(sessionPersistence.capabilityOverlays).toEqual(['windows_sensitive'])
    expect(sessionPersistence.fallbackCapability).toBe('main_runtime')
  })
})
