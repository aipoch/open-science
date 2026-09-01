import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { Prisma } from '@prisma/client'
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isClassDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isVariableDeclaration,
  ScriptTarget,
  type CallExpression,
  type MethodDeclaration,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type SourceFile
} from 'typescript'
import { describe, expect, it } from 'vitest'

import { MAX_NOTIFICATION_INBOX_ITEMS } from '../notifications/notification-inbox-repository'
import { PROJECT_OWNED_DATA_CATALOG } from './project-owned-data.catalog'

const projectRoot = resolve(__dirname, '../../..')
const sourcePath = (relativePath: string): string => resolve(projectRoot, relativePath)
const sourceFile = (relativePath: string): SourceFile => {
  const path = sourcePath(relativePath)
  return createSourceFile(path, readFileSync(path, 'utf8'), ScriptTarget.Latest, true)
}

type SourceScope = Readonly<{ file: SourceFile; node: Node }>
type CallRecord = Readonly<{ callee: string; position: number; call: CallExpression }>

const normalized = (value: string): string => value.replaceAll('?.', '.').replaceAll(/\s+/gu, '')

const visit = (root: Node, inspect: (node: Node) => void): void => {
  inspect(root)
  forEachChild(root, (child) => visit(child, inspect))
}

const classMethod = (relativePath: string, className: string, methodName: string): SourceScope => {
  const file = sourceFile(relativePath)
  let method: MethodDeclaration | undefined
  visit(file, (node) => {
    if (!isClassDeclaration(node) || node.name?.text !== className) return
    method = node.members.find(
      (member): member is MethodDeclaration =>
        isMethodDeclaration(member) && member.name.getText(file) === methodName
    )
  })
  if (!method) throw new Error(`Method not found: ${className}.${methodName}`)
  return { file, node: method }
}

const functionScope = (relativePath: string, functionName: string): SourceScope => {
  const file = sourceFile(relativePath)
  let declaration: Node | undefined
  visit(file, (node) => {
    if (isFunctionDeclaration(node) && node.name?.text === functionName) declaration = node
  })
  if (!declaration) {
    visit(file, (node) => {
      if (
        isIdentifier(node) &&
        node.text === functionName &&
        node.parent &&
        (isPropertyAssignment(node.parent) || isVariableDeclaration(node.parent))
      ) {
        declaration = node.parent.initializer
      }
    })
  }
  if (!declaration) throw new Error(`Function not found: ${functionName}`)
  return { file, node: declaration }
}

const variableInitializer = (relativePath: string, variableName: string): SourceScope => {
  const file = sourceFile(relativePath)
  let initializer: Node | undefined
  visit(file, (node) => {
    if (isVariableDeclaration(node) && node.name.getText(file) === variableName) {
      initializer = node.initializer
    }
  })
  if (!initializer) throw new Error(`Variable initializer not found: ${variableName}`)
  return { file, node: initializer }
}

const callsIn = ({ file, node }: SourceScope): CallRecord[] => {
  const calls: CallRecord[] = []
  visit(node, (candidate) => {
    if (!isCallExpression(candidate)) return
    calls.push({
      callee: normalized(candidate.expression.getText(file)),
      position: candidate.getStart(file),
      call: candidate
    })
  })
  return calls.sort((left, right) => left.position - right.position)
}

const expectCallsInOrder = (scope: SourceScope, expected: readonly string[]): void => {
  const calls = callsIn(scope)
  let cursor = -1
  for (const rawExpected of expected) {
    const callee = normalized(rawExpected)
    const next = calls.findIndex((call, index) => index > cursor && call.callee === callee)
    expect(next, `${callee} after call index ${cursor}`).toBeGreaterThan(cursor)
    cursor = next
  }
}

const expectCall = (scope: SourceScope, expected: string): CallRecord => {
  const callee = normalized(expected)
  const match = callsIn(scope).find((call) => call.callee === callee)
  expect(match, callee).toBeDefined()
  return match!
}

const newExpression = (relativePath: string, className: string): SourceScope => {
  const file = sourceFile(relativePath)
  let expression: Node | undefined
  visit(file, (node) => {
    if (isNewExpression(node) && normalized(node.expression.getText(file)) === className) {
      expression = node
    }
  })
  if (!expression) throw new Error(`Constructor call not found: ${className}`)
  return { file, node: expression }
}

const objectMethod = (
  file: SourceFile,
  object: ObjectLiteralExpression,
  methodName: string
): SourceScope => {
  const property = object.properties.find(
    (candidate) => 'name' in candidate && candidate.name?.getText(file) === methodName
  )
  if (!property) throw new Error(`Object method not found: ${methodName}`)
  if (isMethodDeclaration(property)) return { file, node: property }
  if (isPropertyAssignment(property)) return { file, node: property.initializer }
  throw new Error(`Object property is not callable: ${methodName}`)
}

const objectProperty = (
  file: SourceFile,
  object: ObjectLiteralExpression,
  propertyName: string
): ObjectLiteralElementLike => {
  const property = object.properties.find((candidate) => {
    if (!('name' in candidate) || !candidate.name) return false
    return candidate.name.getText(file) === propertyName
  })
  if (!property) throw new Error(`Object property not found: ${propertyName}`)
  return property
}

const nestedMethod = (scope: SourceScope, methodName: string): SourceScope => {
  let method: MethodDeclaration | undefined
  visit(scope.node, (node) => {
    if (isMethodDeclaration(node) && node.name.getText(scope.file) === methodName) method = node
  })
  if (!method) throw new Error(`Nested method not found: ${methodName}`)
  return { file: scope.file, node: method }
}

const isProjectOwnerField = (name: string): boolean => /(?:^projectId$|ProjectId$)/u.test(name)
const isProjectOrSessionOwnerField = (name: string): boolean =>
  /(?:^(?:project|session)Id$|(?:Project|Session)Id$)/u.test(name)

const dmmfOwnerInventory = (): Array<{
  name: string
  ownerFields: Array<{ name: string; required: boolean }>
}> =>
  Prisma.dmmf.datamodel.models
    .filter((model) =>
      model.fields.some((field) => field.kind === 'scalar' && isProjectOwnerField(field.name))
    )
    .map((model) => ({
      name: model.name,
      ownerFields: model.fields
        .filter((field) => field.kind === 'scalar' && isProjectOrSessionOwnerField(field.name))
        .map((field) => ({ name: field.name, required: field.isRequired }))
        .sort((left, right) => left.name.localeCompare(right.name))
    }))
    .sort((left, right) => left.name.localeCompare(right.name))

const catalogOwnerInventory = (): ReturnType<typeof dmmfOwnerInventory> =>
  PROJECT_OWNED_DATA_CATALOG.flatMap((entry) => entry.prismaModels ?? [])
    .map((model) => ({
      name: model.name,
      ownerFields: [...model.ownerFields]
        .map((field) => ({ name: field.name, required: field.required }))
        .sort((left, right) => left.name.localeCompare(right.name))
    }))
    .sort((left, right) => left.name.localeCompare(right.name))

describe('Project-owned data catalog architecture', () => {
  it('forces every Prisma Project owner model to choose an explicit lifecycle policy', () => {
    expect(catalogOwnerInventory()).toEqual(dmmfOwnerInventory())
  })

  it('locks the curated SQL, filesystem, and runtime ownership inventory', () => {
    expect(PROJECT_OWNED_DATA_CATALOG.map((entry) => entry.id)).toEqual([
      'project-memory',
      'permission-grants',
      'project-preview-state',
      'vision-evidence',
      'session-metadata-usage-history',
      'notification-inbox-history',
      'review-persistence',
      'project-deletion-intent',
      'managed-file-projection',
      'artifact-provenance',
      'compute-jobs',
      'compute-job-remote-workdirs',
      'compute-session-cache',
      'project-session-json',
      'managed-session-workspaces',
      'artifact-bytes',
      'upload-bytes',
      'delegated-frame-workspaces',
      'side-chat-runtime-profiles',
      'acp-runtime-state',
      'reviewer-runtime-state',
      'side-chat-runtime-state',
      'notebook-kernel-runtime-state',
      'compute-runtime-state',
      'notebook-project-workspace',
      'notebook-input-cache',
      'execution-file-evidence'
    ])
    expect(
      [
        ...new Set(
          PROJECT_OWNED_DATA_CATALOG.flatMap((entry) =>
            'path' in entry.policy && entry.policy.path ? [entry.policy.path] : []
          )
        )
      ].sort()
    ).toEqual([
      'compute-job-project-delete',
      'delegated-runtime-quiescence',
      'execution-file-evidence-tail',
      'notebook-input-cache-tail',
      'notification-session-invalidation',
      'project-deletion-intent-protocol',
      'project-file-projection-delete',
      'project-metadata-soft-delete',
      'project-runtime-quiescence',
      'project-session-json-delete',
      'provenance-tail',
      'review-tail',
      'side-chat-profile-tail'
    ])
  })

  it('catalogs current and legacy execution evidence roots as Project-owned data', () => {
    expect(
      PROJECT_OWNED_DATA_CATALOG.find((entry) => entry.id === 'execution-file-evidence')?.resources
    ).toEqual(['execution-file-evidence/<projectId>/', 'notebook-file-evidence/<projectId>/'])
  })

  it('catalogs retained managed Session workspaces as Project-owned data', () => {
    expect(
      PROJECT_OWNED_DATA_CATALOG.find((entry) => entry.id === 'managed-session-workspaces')
    ).toMatchObject({
      medium: 'filesystem',
      resources: ['workspaces/<workspaceId>/'],
      policy: {
        kind: 'retained-history',
        effect: 'retain'
      }
    })
  })

  it('checks declared Prisma cascades and Restrict boundaries through generated DMMF', () => {
    for (const entry of PROJECT_OWNED_DATA_CATALOG) {
      for (const modelContract of entry.prismaModels ?? []) {
        const model = Prisma.dmmf.datamodel.models.find(
          (candidate) => candidate.name === modelContract.name
        )
        expect(model, modelContract.name).toBeDefined()
        for (const relationContract of modelContract.relationContracts ?? []) {
          const relation = model?.fields.find(
            (field) => field.kind === 'object' && field.name === relationContract.field
          )
          expect(relation, `${modelContract.name}.${relationContract.field}`).toMatchObject({
            type: relationContract.target,
            relationFromFields: relationContract.fromFields,
            relationOnDelete: relationContract.onDelete
          })
        }
        if (entry.policy.kind === 'foreign-key-cascade') {
          expect(
            modelContract.relationContracts?.some(
              (relation) => relation.target === 'Project' && relation.onDelete === 'Cascade'
            ),
            `${modelContract.name} Project cascade`
          ).toBe(true)
        }
      }
    }
  })

  it('requires complete policy metadata without registering shared Runtime or Skill packages', () => {
    const ids = new Set<string>()
    for (const entry of PROJECT_OWNED_DATA_CATALOG) {
      expect(ids.has(entry.id), entry.id).toBe(false)
      ids.add(entry.id)
      expect(entry.resources.length, entry.id).toBeGreaterThan(0)

      if (entry.policy.kind === 'coordinator-cleanup') {
        expect(entry.policy.operation.trim(), entry.id).not.toBe('')
        expect(entry.policy.note.trim(), entry.id).not.toBe('')
      } else if (entry.policy.kind === 'retained-history') {
        expect(entry.policy.reason.trim(), entry.id).not.toBe('')
        expect(entry.policy.retention.trim(), entry.id).not.toBe('')
      } else if (entry.policy.kind === 'deletion-protocol') {
        expect(entry.policy.purpose.trim(), entry.id).not.toBe('')
      }
    }
    expect([...ids].filter((id) => /(?:runtime-package|skill-package)/u.test(id))).toEqual([])

    const notification = Prisma.dmmf.datamodel.models.find(
      (model) => model.name === 'NotificationInboxItem'
    )
    expect(
      notification?.fields.find((field) => field.name === 'targetInvalidatedAt')
    ).toMatchObject({
      kind: 'scalar',
      type: 'DateTime',
      isRequired: false
    })
    expect(
      notification?.fields.some((field) => field.kind === 'object' && field.type === 'Project')
    ).toBe(false)
  })

  it('locks the durable Project deletion composition and tail order', () => {
    const constructor = newExpression('src/main/ipc.ts', 'ProjectDeletionCoordinator')
    if (!isNewExpression(constructor.node)) throw new Error('Expected constructor expression.')
    expect(
      constructor.node.arguments?.slice(0, 5).map((argument) => argument.getText(constructor.file))
    ).toEqual([
      'projectRepository',
      'sessionPersistenceCoordinator',
      'reviewRepository',
      'artifactProvenanceRepository',
      'permissionGrantRegistry'
    ])
    const lifecycle = constructor.node.arguments?.[5]
    if (!lifecycle || !isObjectLiteralExpression(lifecycle)) {
      throw new Error('Project deletion lifecycle wiring is not an object literal.')
    }
    expectCall(
      objectMethod(constructor.file, lifecycle, 'beforeProjectDelete'),
      'owner.quiesceProject'
    )

    expectCallsInOrder(
      classMethod(
        'src/main/projects/deletion-coordinator.ts',
        'ProjectDeletionCoordinator',
        'runDeletion'
      ),
      [
        'this.createDeletionIntentWithFence',
        'this.lifecycle?.beforeProjectDelete',
        'this.sessions.deleteProjectSessions',
        'this.finishDeletion'
      ]
    )
    expectCall(
      classMethod(
        'src/main/projects/deletion-coordinator.ts',
        'ProjectDeletionCoordinator',
        'createDeletionIntentWithFence'
      ),
      'this.projects.createDeletionIntent'
    )
    expectCallsInOrder(
      classMethod(
        'src/main/projects/deletion-coordinator.ts',
        'ProjectDeletionCoordinator',
        'finishDeletion'
      ),
      [
        'this.permissionGrants?.prune',
        'this.projects.get',
        'this.projects.delete',
        'this.permissionGrants?.finalizeOwnerDeletion',
        'this.reviews?.deleteReviewsForProject',
        'this.provenance?.deleteProjectProvenance',
        'this.lifecycle?.finalizeProjectDeletion',
        'this.sessions.completeProjectSessionDeletion',
        'this.projects.deleteDeletionIntent'
      ]
    )
    expectCall(
      objectMethod(constructor.file, lifecycle, 'finalizeProjectDeletion'),
      'notebookService.deleteProjectFileEvidence'
    )
    expectCall(
      objectMethod(constructor.file, lifecycle, 'finalizeProjectDeletion'),
      'notebookService.deleteProjectInputs'
    )
  })

  it('proves every live subsystem is wired through pre-authority runtime quiescence', () => {
    const quiescence = classMethod(
      'src/main/projects/project-runtime-quiescence-owner.ts',
      'ProjectRuntimeQuiescenceOwner',
      'quiesceProject'
    )
    expectCallsInOrder(quiescence, [
      'this.options.reviewer.quiesceProject',
      'this.options.sideChat.invalidateProject',
      'this.options.acp.deleteSession',
      'this.options.notebook.shutdownProject',
      'this.options.delegation.deleteProject',
      'this.options.compute.reconcileProject'
    ])
    const acpDeletes = callsIn(quiescence).filter(
      (call) => call.callee === 'this.options.acp.deleteSession'
    )
    const delegatedDelete = expectCall(quiescence, 'this.options.delegation.deleteProject')
    expect(acpDeletes).toHaveLength(2)
    expect(acpDeletes[1]!.position).toBeGreaterThan(delegatedDelete.position)

    const composition = newExpression('src/main/ipc.ts', 'ProjectRuntimeQuiescenceOwner')
    if (!isNewExpression(composition.node)) throw new Error('Expected quiescence constructor.')
    const options = composition.node.arguments?.[0]
    if (!options || !isObjectLiteralExpression(options)) {
      throw new Error('Project runtime quiescence wiring is not an object literal.')
    }
    const reviewer = objectProperty(composition.file, options, 'reviewer')
    const sideChat = objectProperty(composition.file, options, 'sideChat')
    expect(isPropertyAssignment(reviewer) && reviewer.initializer.getText(composition.file)).toBe(
      'reviewerProjectRuntime'
    )
    expect(isPropertyAssignment(sideChat) && sideChat.initializer.getText(composition.file)).toBe(
      'sideChatRuntime'
    )

    for (const [ownerName, methodName, callName] of [
      ['acp', 'deleteSession', 'runtime.deleteSession'],
      ['delegation', 'deleteProject', 'delegatedWork.root.deleteProject'],
      ['notebook', 'shutdownProject', 'notebookService.shutdownProject']
    ] as const) {
      const owner = objectProperty(composition.file, options, ownerName)
      if (!isPropertyAssignment(owner) || !isObjectLiteralExpression(owner.initializer)) {
        throw new Error(`Quiescence owner wiring is not an object: ${ownerName}`)
      }
      expectCall(objectMethod(composition.file, owner.initializer, methodName), callName)
    }
    const compute = objectProperty(composition.file, options, 'compute')
    if (!isPropertyAssignment(compute) || !isObjectLiteralExpression(compute.initializer)) {
      throw new Error('Compute quiescence wiring is not an object.')
    }
    expectCall(
      objectMethod(composition.file, compute.initializer, 'reconcileProject'),
      'deletionOwner.reconcileProjectOrphanJobs'
    )
  })

  it('proves Session JSON, Compute Jobs, and Managed File projection share the durable delete path', () => {
    const deletion = classMethod(
      'src/main/session-persistence/deletion-owner.ts',
      'SessionPersistenceDeletionOwner',
      'deleteProjectSessions'
    )
    expectCall(deletion, 'this.computeJobs?.prepareProjectJobDeletion')
    const repositoryDelete = expectCall(deletion, 'this.repository.deleteProjectSessions')
    const calls = callsIn(deletion)
    const commitAfterAuthority = calls.find(
      (call) =>
        call.position > repositoryDelete.position &&
        call.callee === 'this.computeJobs.commitProjectJobDeletion'
    )
    const projectionAfterCommit = calls.find(
      (call) =>
        commitAfterAuthority &&
        call.position > commitAfterAuthority.position &&
        call.callee === 'this.fileIndex.softDeleteProject'
    )
    const notificationAfterProjection = calls.find(
      (call) =>
        projectionAfterCommit &&
        call.position > projectionAfterCommit.position &&
        call.callee === 'this.notifySessionsDeleted'
    )
    expect(commitAfterAuthority).toBeDefined()
    expect(projectionAfterCommit).toBeDefined()
    expect(notificationAfterProjection).toBeDefined()

    expectCall(
      classMethod(
        'src/main/projects/deletion-coordinator.ts',
        'ProjectDeletionCoordinator',
        'finishDeletion'
      ),
      'this.sessions.completeProjectSessionDeletion'
    )
  })

  it('proves retained notifications are invalidated through the committed Session deletion path', () => {
    expect(MAX_NOTIFICATION_INBOX_ITEMS).toBe(1000)
    expectCall(
      classMethod(
        'src/main/session-persistence/coordinator.ts',
        'SessionPersistenceCoordinator',
        'notifySessionsDeleted'
      ),
      'this.sessionDeletionHandlers?.commit'
    )
    const binding = functionScope(
      'src/main/notifications/notification-inbox-runtime.ts',
      'bindNotificationInboxDeletionRuntime'
    )
    expectCall(binding, 'dependencies.sessionPersistenceCoordinator.setSessionDeletionHandlers')
    expectCall(binding, 'dependencies.inbox.invalidateSessions')

    const ipc = sourceFile('src/main/ipc.ts')
    let bindCall: CallExpression | undefined
    visit(ipc, (node) => {
      if (
        isCallExpression(node) &&
        normalized(node.expression.getText(ipc)) === 'bindNotificationInboxDeletionRuntime'
      ) {
        bindCall = node
      }
    })
    const options = bindCall?.arguments[0]
    if (!options || !isObjectLiteralExpression(options)) {
      throw new Error('Notification deletion runtime is not wired from the composition root.')
    }
    const inbox = objectProperty(ipc, options, 'inbox')
    expect(isPropertyAssignment(inbox) && inbox.initializer.getText(ipc)).toBe('notificationInbox')
    expect(
      isShorthandPropertyAssignment(objectProperty(ipc, options, 'sessionPersistenceCoordinator'))
    ).toBe(true)
  })

  it('proves Compute cleanup removes remote work before deleting owner rows', () => {
    expectCall(
      classMethod(
        'src/main/compute/job-deletion-owner.ts',
        'ComputeJobDeletionOwner',
        'commitProjectJobDeletion'
      ),
      'this.commitOwner'
    )
    expectCallsInOrder(
      classMethod(
        'src/main/compute/job-deletion-owner.ts',
        'ComputeJobDeletionOwner',
        'commitOwner'
      ),
      ['this.runRemoteCleanup', 'this.deps.lifecycle.deleteOwnerRows']
    )
    expectCall(
      classMethod(
        'src/main/compute/compute-job-lifecycle.ts',
        'ComputeJobLifecycle',
        'deleteOwnerRows'
      ),
      'this.repository.deleteByOwner'
    )
  })

  it('proves Session cache follows the Compute Project deletion path', () => {
    expect(
      PROJECT_OWNED_DATA_CATALOG.find((entry) => entry.id === 'compute-session-cache')
    ).toMatchObject({
      medium: 'filesystem',
      resources: ['compute/session-cache/<projectId>/<sessionId>/'],
      policy: {
        kind: 'coordinator-cleanup',
        effect: 'hard-delete',
        path: 'compute-job-project-delete',
        operation: 'SessionCacheOwner.removeProject'
      }
    })
    expectCallsInOrder(
      functionScope('src/main/compute/session-cache-owner.ts', 'withSessionCacheDeletion'),
      ['jobs.commitProjectJobDeletion', 'cache.removeProject']
    )
  })

  it('proves Session tombstones and delegated workspaces perform their declared filesystem cleanup', () => {
    expect(
      PROJECT_OWNED_DATA_CATALOG.find((entry) => entry.id === 'project-session-json')?.resources
    ).toEqual(['sessions/<projectId>/', 'deleted-sessions/<projectId>/'])
    expect(
      normalized(
        variableInitializer(
          'src/main/session-persistence/repository.ts',
          'DELETED_SESSIONS_DIR'
        ).node.getText()
      )
    ).toBe("'deleted-sessions'")
    expectCallsInOrder(
      classMethod(
        'src/main/session-persistence/repository.ts',
        'SessionRepository',
        'deleteProjectSessions'
      ),
      ['writeFile', 'rename']
    )
    expectCall(
      classMethod(
        'src/main/session-persistence/repository.ts',
        'SessionRepository',
        'completeProjectSessionDeletion'
      ),
      'this.dependencies.remove'
    )

    const delegated = functionScope(
      'src/main/delegation/production-composition.ts',
      'createProductionDelegatedWorkComposition'
    )
    expect(
      PROJECT_OWNED_DATA_CATALOG.find((entry) => entry.id === 'delegated-frame-workspaces')
        ?.resources
    ).toEqual(['delegation/<projectId>/'])
    const workspaceConstruction = expectCall(delegated, 'createProductionFrameWorkspace').call
      .arguments[0]
    expect(workspaceConstruction && isObjectLiteralExpression(workspaceConstruction)).toBe(true)
    expect(
      normalized(
        objectProperty(
          delegated.file,
          workspaceConstruction as ObjectLiteralExpression,
          'root'
        ).getText(delegated.file)
      )
    ).toBe("root:join(options.dataRoot,'delegation')")
    expectCall(nestedMethod(delegated, 'deleteProject'), 'workspace.deleteProject')
    const workspace = functionScope(
      'src/main/delegation/frame-workspace.ts',
      'createProductionFrameWorkspace'
    )
    const workspaceDelete = nestedMethod(workspace, 'deleteProject')
    expectCallsInOrder(workspaceDelete, ['makeTreeRemovable', 'rm'])
  })

  it('catalogs persistent Side Chat profiles and wires their Project deletion tail', () => {
    expect(
      PROJECT_OWNED_DATA_CATALOG.find((entry) => entry.id === 'side-chat-runtime-profiles')
    ).toMatchObject({
      medium: 'filesystem',
      resources: ['runtime-support/side-chat/<sideChatId>/'],
      policy: {
        kind: 'coordinator-cleanup',
        effect: 'hard-delete',
        path: 'side-chat-profile-tail',
        operation: 'SideChatRuntimeOwner.completeProjectDeletion'
      }
    })

    const constructor = newExpression('src/main/ipc.ts', 'ProjectDeletionCoordinator')
    if (!isNewExpression(constructor.node)) throw new Error('Expected constructor expression.')
    const lifecycle = constructor.node.arguments?.[5]
    if (!lifecycle || !isObjectLiteralExpression(lifecycle)) {
      throw new Error('Project deletion lifecycle wiring is not an object literal.')
    }
    expectCall(
      objectMethod(constructor.file, lifecycle, 'finalizeProjectDeletion'),
      'owner.completeProjectDeletion'
    )
    expectCall(
      classMethod(
        'src/main/side-chat/runtime-owner.ts',
        'SideChatRuntimeOwner',
        'completeProjectDeletion'
      ),
      'rm'
    )
  })

  it('proves provenance cleanup owns Restrict-ordered rows and managed bytes', () => {
    const cleanup = classMethod(
      'src/main/artifacts/provenance-repository.ts',
      'ArtifactProvenanceRepository',
      'deleteProjectProvenance'
    )
    expectCallsInOrder(cleanup, [
      'client.uploadVersion.findMany',
      'rm',
      'client.$transaction',
      'tx.artifactVersionInput.deleteMany',
      'tx.artifactLineage.deleteMany',
      'tx.uploadFile.deleteMany',
      'tx.artifactMessageSnapshot.deleteMany',
      'tx.fileOriginSession.deleteMany',
      'rm'
    ])
  })
})
