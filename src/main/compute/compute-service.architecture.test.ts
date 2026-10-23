import {
  expectTypeOnlyContract,
  runtimeModuleSpecifiers,
  expectBoundaryPaths,
  expectBoundaryOwnerTests
} from '../../../test/module-boundary-assertions'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, relative, resolve } from 'node:path'

import {
  canHaveModifiers,
  createSourceFile,
  forEachChild,
  getModifiers,
  isArrowFunction,
  isCallExpression,
  isClassDeclaration,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isMethodDeclaration,
  isNamedExports,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isStringLiteralLike,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type Node,
  type SourceFile
} from 'typescript'
import { describe, expect, it } from 'vitest'

import { loadModuleImpactManifest } from '../../../scripts/ci/load-module-impact.mjs'

import { RENDERER_CONTRACT_CATALOG } from '../../shared/renderer-contract-catalog'

const projectRoot = resolve(__dirname, '../../..')
const mainRoot = resolve(projectRoot, 'src/main')
const manifestPath = resolve(projectRoot, 'scripts/ci/module-impact.json')
const computePaths = {
  connectionBroker: resolve(mainRoot, 'compute/connection-broker.ts'),
  facade: resolve(mainRoot, 'compute/compute-service.ts'),
  hostOwner: resolve(mainRoot, 'compute/compute-host-profile-owner.ts'),
  remoteOwner: resolve(mainRoot, 'compute/compute-remote-operation-owner.ts'),
  jobOwner: resolve(mainRoot, 'compute/compute-job-workflow-owner.ts'),
  deletionOwner: resolve(mainRoot, 'compute/job-deletion-owner.ts'),
  jobLifecycle: resolve(mainRoot, 'compute/compute-job-lifecycle.ts'),
  jobRepository: resolve(mainRoot, 'compute/job-repository.ts'),
  cancellationOwner: resolve(mainRoot, 'compute/compute-job-cancellation-owner.ts'),
  operationRepository: resolve(mainRoot, 'compute/compute-job-operation-repository.ts'),
  concurrencyManager: resolve(mainRoot, 'compute/concurrency-manager.ts'),
  jobDispatcher: resolve(mainRoot, 'compute/job-dispatcher.ts'),
  jobPoller: resolve(mainRoot, 'compute/job-poller.ts'),
  ipc: resolve(mainRoot, 'compute/ipc.ts'),
  mainIpc: resolve(mainRoot, 'ipc-application-composition.ts'),
  applicationCommands: resolve(mainRoot, 'compute/application-commands.ts'),
  jobRuntime: resolve(mainRoot, 'compute/job-runtime.ts'),
  localRpc: resolve(mainRoot, 'notebook/local-rpc-server.ts')
} as const

const readSource = (path: string): string => readFileSync(path, 'utf8')
const modulePath = (path: string): string => path.replace(/\.[cm]?[jt]sx?$/, '')
const portableProjectPath = (path: string): string =>
  relative(projectRoot, path).replaceAll('\\', '/')
const sourceFileFor = (path: string): SourceFile =>
  createSourceFile(
    path,
    readSource(path),
    ScriptTarget.Latest,
    true,
    extname(path) === '.tsx' ? ScriptKind.TSX : ScriptKind.TS
  )

const productionSources = (): string[] => {
  const sources: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (
        ['.ts', '.tsx'].includes(extname(path)) &&
        !/\.(?:test|spec)\.[cm]?tsx?$/.test(entry.name)
      ) {
        sources.push(path)
      }
    }
  }
  visit(mainRoot)
  return sources.sort()
}

const importSpecifiersFrom = (sourcePath: string): string[] => {
  const specifiers: string[] = []
  const visit = (node: Node): void => {
    if (
      (isImportDeclaration(node) || isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (isImportTypeNode(node)) {
      const argument = node.argument
      if (isLiteralTypeNode(argument) && isStringLiteralLike(argument.literal)) {
        specifiers.push(argument.literal.text)
      }
    } else if (isCallExpression(node)) {
      const [argument] = node.arguments
      const isRequire = isIdentifier(node.expression) && node.expression.text === 'require'
      const isDynamicImport = node.expression.kind === SyntaxKind.ImportKeyword
      if ((isRequire || isDynamicImport) && argument && isStringLiteralLike(argument)) {
        specifiers.push(argument.text)
      }
    }
    forEachChild(node, visit)
  }
  visit(sourceFileFor(sourcePath))
  return specifiers
}

const resolveImportTarget = (sourcePath: string, specifier: string): string | undefined =>
  specifier.startsWith('.') ? modulePath(resolve(dirname(sourcePath), specifier)) : undefined

const importedNamesFrom = (sourcePath: string, target: string): string[] => {
  const names: string[] = []
  for (const statement of sourceFileFor(sourcePath).statements) {
    if (
      !isImportDeclaration(statement) ||
      !isStringLiteralLike(statement.moduleSpecifier) ||
      resolveImportTarget(sourcePath, statement.moduleSpecifier.text) !== modulePath(target)
    ) {
      continue
    }
    const bindings = statement.importClause?.namedBindings
    if (bindings && 'elements' in bindings) {
      names.push(
        ...bindings.elements.map((element) => element.propertyName?.text ?? element.name.text)
      )
    }
  }
  return names.sort()
}

const calledMembersOn = (sourcePath: string, receiver: readonly string[]): string[] => {
  const calls = new Set<string>()
  const matchesReceiver = (node: Node): boolean => {
    let current: Node = node
    for (let index = receiver.length - 1; index >= 0; index -= 1) {
      if (index === 0) {
        return receiver[index] === 'this'
          ? current.kind === SyntaxKind.ThisKeyword
          : isIdentifier(current) && current.text === receiver[index]
      }
      if (!isPropertyAccessExpression(current) || current.name.text !== receiver[index])
        return false
      current = current.expression
    }
    return false
  }
  const visit = (node: Node): void => {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      matchesReceiver(node.expression.expression)
    ) {
      calls.add(node.expression.name.text)
    }
    forEachChild(node, visit)
  }
  visit(sourceFileFor(sourcePath))
  return [...calls].sort()
}

const referencedMembersOn = (sourcePath: string, receiver: readonly string[]): string[] => {
  const references = new Set<string>()
  const matchesReceiver = (node: Node): boolean => {
    let current: Node = node
    for (let index = receiver.length - 1; index >= 0; index -= 1) {
      if (index === 0) {
        return receiver[index] === 'this'
          ? current.kind === SyntaxKind.ThisKeyword
          : isIdentifier(current) && current.text === receiver[index]
      }
      if (!isPropertyAccessExpression(current) || current.name.text !== receiver[index])
        return false
      current = current.expression
    }
    return false
  }
  const visit = (node: Node): void => {
    if (isPropertyAccessExpression(node) && matchesReceiver(node.expression)) {
      references.add(node.name.text)
    }
    forEachChild(node, visit)
  }
  visit(sourceFileFor(sourcePath))
  return [...references].sort()
}

const privateOwnerPaths = [
  computePaths.hostOwner,
  computePaths.remoteOwner,
  computePaths.jobOwner
] as const
const productionSourcePaths = productionSources()

describe('Compute service architecture', () => {
  it('wires facade collaborators by name instead of positional optional arguments', () => {
    const facade = readSource(computePaths.facade)
    expect(facade).not.toMatch(/constructor\(\s*runner:/)

    const ipc = readSource(computePaths.ipc)
    expect(ipc).toContain('new ComputeService({')
    expect(ipc).not.toMatch(/new ComputeService\(\s*sshRunner,/)
  })

  it('restores local owner barriers before runtime and defers remote recovery until after startup', () => {
    const root = readSource(computePaths.mainIpc)
    const calls = [
      'await composeComputeAdmission({',
      'await composeSideChat({',
      'await composeComputeRecovery({',
      'await composeProjectRecovery({'
    ]
    let previous = -1
    for (const call of calls) {
      const index = root.indexOf(call)
      expect(index, call).toBeGreaterThan(previous)
      previous = index
    }
    const admission = readSource(resolve(mainRoot, 'composition/compute.ts'))
    const projectBarriers = admission.indexOf(
      'projectDeletionCoordinator.restorePendingDeletionBarriers()'
    )
    expect(projectBarriers).toBeGreaterThan(-1)
    expect(
      admission.indexOf('await jobDeletionOwner.restoreOrphanJobDeletionBarriers')
    ).toBeGreaterThan(projectBarriers)
    const sideChat = readSource(resolve(mainRoot, 'composition/side-chat.ts'))
    expect(sideChat).toContain(
      'projectRuntimeQuiescenceRef.current = new ProjectRuntimeQuiescenceOwner'
    )
    expect(sideChat).toContain(
      'await deletionOwner.reconcileProjectOrphanJobs(projectId, isComputeJobOwnerLive)'
    )
    const recovery = readSource(resolve(mainRoot, 'composition/project-lifecycle.ts'))
    const ordered = [
      'const projectDeletionRecovery = new ProjectDeletionRecoveryLoop',
      'recoverOrphanJobs: () => jobDeletionOwner.reconcileOrphanJobs(isComputeJobOwnerLive)',
      'replaySessionProjection: () => sessionRepository.reconcilePendingSessionProjection()',
      'recoverProjects: () => projectDeletionCoordinator.recoverPendingDeletions()',
      "event.payload.status === 'cleanup-pending'",
      'projectDeletionRecovery.wake()'
    ]
    previous = -1
    for (const step of ordered) {
      const index = recovery.indexOf(step, previous + 1)
      expect(index, step).toBeGreaterThan(previous)
      previous = index
    }
  })

  it('gives Compute Job shutdown the transport cancellation budget', () => {
    const source = readSource(resolve(mainRoot, 'composition/compute-recovery.ts'))
    expect(source).toContain('const jobPoller = createComputeJobRuntime')
    expect(source).toContain('disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS')
    expect(source).toContain('dispose: () => jobPoller.stop()')
  })

  it('resolves Compute policy without entering Session catalog hydration or coordinator locks', () => {
    const source = readSource(resolve(mainRoot, 'composition/compute.ts'))
    const start = source.indexOf('const sessionLimitPersistence = {')
    const write = source.indexOf('save: async', start)
    const resolver = source.slice(start, write)
    expect(resolver).toContain('sessionRepository.loadComputePolicy')
    expect(resolver).not.toContain('loadAllSessions')
    expect(resolver).not.toContain('sessionPersistenceCoordinator')
    expect(resolver).not.toContain('canReconcileSessionAbsences')
  })

  it('persists Session concurrency limits inside the data-root write boundary', () => {
    const source = readSource(resolve(mainRoot, 'composition/compute.ts'))
    const persistenceStart = source.indexOf('const sessionLimitPersistence = {')
    const persistenceEnd = source.indexOf(
      'const computeIpcModule = createComputeIpcModule',
      persistenceStart
    )
    const persistence = source.slice(persistenceStart, persistenceEnd)
    const writeBoundary = persistence.indexOf('withDataRootWrite(')
    const sessionMutation = persistence.indexOf(
      'sessionPersistenceCoordinator.setSessionComputeConcurrencyLimit'
    )

    expect(persistenceStart).toBeGreaterThan(-1)
    expect(persistenceEnd).toBeGreaterThan(persistenceStart)
    expect(writeBoundary).toBeGreaterThan(-1)
    expect(sessionMutation).toBeGreaterThan(writeBoundary)
  })

  it('awaits Compute Job barrier rollback when a new Project deletion aborts', () => {
    const source = readSource(resolve(mainRoot, 'composition/project-lifecycle.ts'))
    const abortStart = source.indexOf('abortProjectDeletion: async (projectId) => {')
    const abortEnd = source.indexOf('const detectArchiveBlockingSessions', abortStart)
    const abortSource = source.slice(abortStart, abortEnd)

    expect(abortStart).toBeGreaterThan(-1)
    expect(abortEnd).toBeGreaterThan(abortStart)
    expect(abortSource).toContain('await computeJobDeletionPort.abortProjectJobDeletion(projectId)')
  })

  it('treats unreadable Session authority as unknown during Compute Job recovery', () => {
    const source = readSource(resolve(mainRoot, 'composition/session-authority.ts'))
    const livenessStart = source.indexOf('const isComputeJobOwnerLive')
    const livenessEnd = source.indexOf('const computeJobDeletionRef', livenessStart)
    const livenessSource = source.slice(livenessStart, livenessEnd)

    expect(livenessStart).toBeGreaterThan(-1)
    expect(livenessEnd).toBeGreaterThan(livenessStart)
    expect(livenessSource).toContain("return 'unknown'")
    expect(livenessSource).not.toContain('throw new Error')
    expect(readSource(resolve(mainRoot, 'composition/compute.ts'))).toContain(
      'restoreOrphanJobDeletionBarriers(isComputeJobOwnerLive)'
    )
  })

  it('keeps every private owner behind the public facade', () => {
    const ownerTargets = new Set(privateOwnerPaths.map(modulePath))
    const ownerModuleNames = privateOwnerPaths.map((path) => basename(modulePath(path)))
    const importers = new Map(
      privateOwnerPaths.map((path) => [modulePath(path), new Set<string>()])
    )

    for (const sourcePath of productionSourcePaths) {
      const source = readSource(sourcePath)
      if (!ownerModuleNames.some((name) => source.includes(name))) continue
      for (const specifier of importSpecifiersFrom(sourcePath)) {
        const target = resolveImportTarget(sourcePath, specifier)
        if (target && ownerTargets.has(target)) {
          importers.get(target)?.add(portableProjectPath(sourcePath))
        }
      }
    }

    for (const ownerPath of privateOwnerPaths) {
      expect(
        [...(importers.get(modulePath(ownerPath)) ?? [])],
        portableProjectPath(ownerPath)
      ).toEqual(
        ownerPath === computePaths.jobOwner
          ? [
              'src/main/composition/compute.ts',
              'src/main/compute/compute-service.ts',
              'src/main/compute/ipc.ts'
            ]
          : ['src/main/compute/compute-service.ts']
      )
      if (ownerPath === computePaths.jobOwner) {
        expect(importedNamesFrom(resolve(mainRoot, 'composition/compute.ts'), ownerPath)).toEqual([
          'createComputeArtifactResolver'
        ])
        expect(importedNamesFrom(computePaths.ipc, ownerPath)).toEqual(['ArtifactResolver'])
      }
    }
  })

  it('locks the stable facade operation inventory and bound update sink', () => {
    const facade = sourceFileFor(computePaths.facade).statements.find(
      (statement) => isClassDeclaration(statement) && statement.name?.text === 'ComputeService'
    )
    expect(facade && isClassDeclaration(facade)).toBe(true)
    if (!facade || !isClassDeclaration(facade)) return

    const isPrivate = (member: (typeof facade.members)[number]): boolean =>
      canHaveModifiers(member) &&
      getModifiers(member)?.some((modifier) => modifier.kind === SyntaxKind.PrivateKeyword) === true
    const publicOperations = facade.members
      .flatMap((member) => {
        if (
          isPrivate(member) ||
          (!isMethodDeclaration(member) && !isPropertyDeclaration(member)) ||
          !isIdentifier(member.name)
        ) {
          return []
        }
        return [member.name.text]
      })
      .sort()

    expect(publicOperations).toEqual(
      [
        'execution',
        'appendDetails',
        'bindJobHarvestRetry',
        'callCommand',
        'cancelJob',
        'clearScratchRoot',
        'download',
        'getDetails',
        'getJobResult',
        'getJobStatus',
        'getSessionConcurrencyStatus',
        'handleJobUpdated',
        'handleJobCancellationConfirmed',
        'list',
        'listDir',
        'probe',
        'replaceDetails',
        'retryJobHarvest',
        'setConcurrencyLimit',
        'setExecutionMode',
        'setScratchRoot',
        'setSessionConcurrencyLimit',
        'startQueueReconciliation',
        'stopQueueReconciliation',
        'submitJob'
      ].sort()
    )

    const updateSink = facade.members.find(
      (member) => isPropertyDeclaration(member) && member.name.getText() === 'handleJobUpdated'
    )
    const isBoundUpdateSink =
      updateSink !== undefined &&
      isPropertyDeclaration(updateSink) &&
      updateSink.initializer !== undefined &&
      isArrowFunction(updateSink.initializer)
    expect(isBoundUpdateSink).toBe(true)
  })

  it('keeps Electron, application commands and job updates on the facade seam', () => {
    expect(importedNamesFrom(computePaths.ipc, computePaths.facade)).toEqual(['ComputeService'])
    expect(importedNamesFrom(computePaths.jobRuntime, computePaths.facade)).toEqual([
      'ComputeService'
    ])
    const contract = resolve(__dirname, 'handler-contract.ts')
    const handlers = existsSync(contract) ? contract : computePaths.ipc
    expect(importedNamesFrom(computePaths.applicationCommands, handlers)).toEqual([
      'ComputeHandlers'
    ])
    if (handlers === contract) {
      expectTypeOnlyContract(contract, readSource(contract))
      expect(runtimeModuleSpecifiers(readSource(computePaths.applicationCommands))).not.toContain(
        './handler-contract'
      )
      expect(importedNamesFrom(computePaths.ipc, contract)).toEqual(['ComputeHandlers'])
      expect(
        sourceFileFor(computePaths.ipc)
          .statements.filter(isExportDeclaration)
          .flatMap((statement) =>
            statement.isTypeOnly && statement.exportClause && isNamedExports(statement.exportClause)
              ? statement.exportClause.elements.map((element) => element.name.text)
              : []
          )
      ).toContain('ComputeHandlers')
    }

    expect(referencedMembersOn(computePaths.jobRuntime, ['deps', 'computeService'])).toEqual([
      'bindJobHarvestRetry',
      'execution',
      'handleJobCancellationConfirmed',
      'handleJobUpdated',
      'startQueueReconciliation',
      'stopQueueReconciliation'
    ])
  })

  it('keeps the Session-bound local RPC capability on its established facade operations', () => {
    expect(calledMembersOn(computePaths.localRpc, ['this', 'computeService'])).toEqual([
      'appendDetails',
      'callCommand',
      'cancelJob',
      'download',
      'getDetails',
      'getJobResult',
      'getJobStatus',
      'getSessionConcurrencyStatus',
      'list',
      'listCompute',
      'listHosts',
      'listPreferred',
      'listRegistered',
      'replaceDetails',
      'setSessionConcurrencyLimit',
      'submitJob'
    ])
  })

  it('preserves the registered Electron and Web capability boundary', () => {
    const computeContracts = RENDERER_CONTRACT_CATALOG.filter(
      ({ channel }) => channel?.startsWith('compute:') === true
    )
    expect(computeContracts).toHaveLength(39)
    const remoteRestricted = computeContracts.filter(
      ({ surfaceInstallation }) => surfaceInstallation.remoteWeb === 'rejecting-stub'
    )
    expect(remoteRestricted.map(({ channel }) => channel).sort()).toEqual([
      'compute:change-authentication',
      'compute:create-password',
      'compute:download',
      'compute:jobs:set-remote-cleanup',
      'compute:password-capability',
      'compute:reset-password',
      'compute:reveal-in-folder'
    ])
    for (const contract of remoteRestricted) {
      expect(contract.surfaceInstallation).toEqual({
        electron: 'preload',
        localWeb: 'web-rpc',
        remoteWeb: 'rejecting-stub'
      })
    }
  })

  it('registers the complete facade, owner and cross-surface certification boundary', () => {
    const manifest = loadModuleImpactManifest(manifestPath)
    const computeService = manifest.modules.compute_service

    expectBoundaryPaths(manifest, 'compute_service', [
      'src/main/compute/approval-session-lifecycle.ts',
      'src/main/compute/agent-compute-service.ts',
      'src/main/compute/compute-approval-broker.ts',
      'src/main/compute/compute-host-profile-owner.ts',
      'src/main/compute/compute-job-workflow-owner.ts',
      'src/main/compute/compute-job-operation-repository.ts',
      'src/main/compute/compute-remote-operation-owner.ts',
      'src/main/compute/job-runtime.ts',
      'src/main/compute/job-notifier.ts',
      'src/main/compute/harvest-engine.ts',
      'src/main/compute/job-repository.ts',
      'src/main/compute/enabled-hosts-registry.ts',
      'src/main/compute/session-enabled-hosts-owner.ts',
      'src/main/compute/permission-grant-adapter.ts',
      'src/main/compute/repository.ts',
      'src/main/compute/session-cache-owner.ts',
      'src/main/compute/compute-auth-owner.ts',
      'src/main/compute/connection-adapters.ts',
      'src/main/compute/credential-vault.ts',
      'src/main/compute/compute-service.ts',
      'src/renderer/src/lib/compute/job-analysis-trigger.ts',
      'src/renderer/src/lib/compute/useJobAnalysisEffect.ts',
      'src/renderer/src/lib/compute/useSessionJobHydration.ts',
      'src/renderer/src/lib/compute/WorkspaceComputeRecoveryBridge.tsx',
      'resources/skills/remote-compute-ssh/SKILL.md',
      'src/main/compute/agent-compute-service.test.ts',
      'src/main/compute/agent-no-list-jobs.test.ts',
      'src/main/compute/ambiguous-dispatch-recovery.integration.test.ts',
      'src/main/compute/application-commands.test.ts',
      'src/main/compute/application-commands.ts',
      'src/main/compute/approval-session-lifecycle.test.ts',
      'src/main/compute/authentication-runtime.test.ts',
      'src/main/compute/authentication-runtime.ts',
      'src/main/compute/compute-approval-broker.test.ts',
      'src/main/compute/compute-auth-owner.test.ts',
      'src/main/compute/compute-host-deletion-owner.ts',
      'src/main/compute/compute-host-profile-concurrency.test.ts',
      'src/main/compute/compute-host-profile-owner.test.ts',
      'src/main/compute/compute-integration.test-support.ts',
      'src/main/compute/cancellation-persistence.integration.test.ts',
      'src/main/compute/cancellation-no-launch.integration.test.ts',
      'src/main/compute/job-cleanup-retry.integration.test.ts',
      'src/main/compute/compute-job-operation-repository.test.ts',
      'src/main/compute/cancellation-runtime.integration.test.ts',
      'src/main/compute/cancellation.real-ssh.integration.test.ts',
      'src/main/compute/compute-job-lifecycle.test.ts',
      'src/main/compute/compute-job-workflow-owner.test.ts',
      'src/main/compute/compute-jobs.integration.test.ts',
      'src/main/compute/compute-password-auth.architecture.test.ts',
      'src/main/compute/compute-password-auth.real-ssh.integration.test.ts',
      'src/main/compute/compute-password-auth.release.test.ts',
      'src/main/compute/compute-probe-script.test.ts',
      'src/main/compute/compute-remote-operation-owner.test.ts',
      'src/main/compute/compute-service.architecture.test.ts',
      'src/main/compute/compute-service.test.ts',
      'src/main/compute/concurrency-integration.test.ts',
      'src/main/compute/connection-broker.test.ts',
      'src/main/compute/connection-broker.ts',
      'src/main/compute/credential-vault.test.ts',
      'src/main/compute/electron-ipc-adapter.ts',
      'src/main/compute/enabled-hosts-registry.test.ts',
      'src/main/compute/harvest-engine.test.ts',
      'src/main/compute/ipc.test.ts',
      'src/main/compute/ipc.ts',
      'src/main/compute/job-deletion-runtime-drain.test.ts',
      'src/main/compute/job-deletion-runtime-isolation.test-support.ts',
      'src/main/compute/job-deletion-runtime-isolation.test.ts',
      'src/main/compute/job-dispatcher.test.ts',
      'src/main/compute/job-notifier.integration.test.ts',
      'src/main/compute/job-notifier.test.ts',
      'src/main/compute/job-poll-protocol.integration.test.ts',
      'src/main/compute/job-poller.test.ts',
      'src/main/compute/job-recovery-regressions.integration.test.ts',
      'src/main/compute/job-repository.test.ts',
      'src/main/compute/job-runtime.test.ts',
      'src/main/compute/permission-grant-adapter.test.ts',
      'src/main/compute/prisma-client.test.ts',
      'src/main/compute/remote-compute-skill.test.ts',
      'src/main/compute/repository.test.ts',
      'src/main/compute/session-cache-owner.test.ts',
      'src/main/compute/session-catalog-hydration.integration.test.ts',
      'src/main/compute/session-catalog-hydration.ts',
      'src/main/compute/session-compute-host-access.test.ts',
      'src/main/compute/session-compute-host-access.ts',
      'src/main/compute/session-enabled-hosts-owner.test.ts',
      'src/main/compute/skill-doc.test.ts',
      'src/main/compute/skill-doc.ts',
      'src/main/compute/skill-provisioning.test.ts',
      'src/main/compute/slurm.real-ssh.integration.test.ts',
      'src/main/compute/ssh-config.test.ts',
      'src/main/compute/ssh-config.ts',
      'src/main/compute/workspace-path.ts',
      'src/renderer/src/lib/compute/WorkspaceComputeRecoveryBridge.render.test.tsx',
      'src/renderer/src/lib/compute/job-analysis-trigger.test.ts',
      'src/renderer/src/lib/compute/useJobAnalysisEffect.render.test.tsx',
      'src/renderer/src/lib/compute/useSessionJobHydration.render.test.tsx',
      'src/main/compute/compute-submission-evidence-recovery.integration.test.ts',
      'resources/compute-askpass-win.cjs',
      'resources/compute-askpass.cjs',
      'resources/compute-askpass.sh',
      'src/main/compute/dispatch-evidence.ts'
    ])
    expect(computeService.interfacePaths).toEqual(
      expect.arrayContaining([
        'src/main/compute/connection-broker.ts',
        'src/main/compute/compute-service.ts',
        'src/main/compute/ipc.ts',
        'src/main/compute/electron-ipc-adapter.ts',
        'src/renderer/src/lib/compute/useJobAnalysisEffect.ts',
        'src/main/compute/agent-compute-service.ts',
        'src/main/compute/application-commands.ts',
        'src/main/compute/approval-session-lifecycle.ts',
        'src/main/compute/compute-approval-broker.ts',
        'src/main/compute/compute-job-operation-repository.ts',
        'src/main/compute/compute-job-workflow-owner.ts',
        'src/main/compute/compute-remote-operation-owner.ts',
        'src/main/compute/enabled-hosts-registry.ts',
        'src/main/compute/job-repository.ts',
        'src/main/compute/job-runtime.ts',
        'src/main/compute/repository.ts',
        'src/main/compute/session-cache-owner.ts',
        'src/main/compute/session-catalog-hydration.ts',
        'src/main/compute/session-compute-host-access.ts',
        'src/main/compute/session-enabled-hosts-owner.ts',
        'src/main/compute/skill-doc.ts',
        'src/renderer/src/lib/compute/WorkspaceComputeRecoveryBridge.tsx',
        'src/renderer/src/lib/compute/useSessionJobHydration.ts'
      ])
    )
    expect(computeService.consumerModules).toEqual(expect.arrayContaining(['workspace_page']))
    expectBoundaryOwnerTests(manifest, 'compute_service', [
      'src/main/compute/approval-session-lifecycle.test.ts',
      'src/main/compute/agent-compute-service.test.ts',
      'src/main/compute/agent-no-list-jobs.test.ts',
      'src/main/compute/compute-approval-broker.test.ts',
      'src/main/compute/compute-job-lifecycle.test.ts',
      'src/main/compute/compute-service.architecture.test.ts',
      'src/main/compute/compute-host-profile-owner.test.ts',
      'src/main/compute/compute-job-workflow-owner.test.ts',
      'src/main/compute/cancellation-persistence.integration.test.ts',
      'src/main/compute/cancellation-no-launch.integration.test.ts',
      'src/main/compute/job-cleanup-retry.integration.test.ts',
      'src/main/compute/compute-job-operation-repository.test.ts',
      'src/main/compute/cancellation-runtime.integration.test.ts',
      'src/main/compute/cancellation.real-ssh.integration.test.ts',
      'src/main/compute/job-recovery-regressions.integration.test.ts',
      'src/main/compute/compute-remote-operation-owner.test.ts',
      'src/main/compute/session-cache-owner.test.ts',
      'src/main/compute/session-enabled-hosts-owner.test.ts',
      'src/main/compute/permission-grant-adapter.test.ts',
      'src/main/compute/repository.test.ts',
      'src/main/compute/compute-service.test.ts',
      'src/main/compute/compute-auth-owner.test.ts',
      'src/main/compute/connection-broker.test.ts',
      'src/main/compute/credential-vault.test.ts',
      'src/main/compute/compute-password-auth.architecture.test.ts',
      'src/main/compute/compute-jobs.integration.test.ts',
      'src/main/compute/concurrency-integration.test.ts',
      'src/main/compute/ambiguous-dispatch-recovery.integration.test.ts',
      'src/main/compute/job-poll-protocol.integration.test.ts',
      'src/main/compute/job-notifier.integration.test.ts',
      'src/main/compute/job-deletion-runtime-drain.test.ts',
      'src/main/compute/job-deletion-runtime-isolation.test.ts',
      'src/main/compute/harvest-engine.test.ts',
      'src/main/compute/job-notifier.test.ts',
      'src/main/compute/remote-compute-skill.test.ts',
      'src/renderer/src/lib/compute/WorkspaceComputeRecoveryBridge.render.test.tsx',
      'src/renderer/src/lib/compute/job-analysis-trigger.test.ts',
      'src/renderer/src/lib/compute/useJobAnalysisEffect.render.test.tsx',
      'src/renderer/src/lib/compute/useSessionJobHydration.render.test.tsx',
      'src/main/compute/authentication-runtime.test.ts',
      'src/main/compute/compute-host-profile-concurrency.test.ts',
      'src/main/compute/compute-password-auth.real-ssh.integration.test.ts',
      'src/main/compute/compute-password-auth.release.test.ts',
      'src/main/compute/compute-probe-script.test.ts',
      'src/main/compute/prisma-client.test.ts',
      'src/main/compute/session-catalog-hydration.integration.test.ts',
      'src/main/compute/session-compute-host-access.test.ts',
      'src/main/compute/skill-doc.test.ts',
      'src/main/compute/skill-provisioning.test.ts',
      'src/main/compute/slurm.real-ssh.integration.test.ts',
      'src/main/compute/ssh-config.test.ts',
      'src/main/compute/compute-submission-evidence-recovery.integration.test.ts'
    ])
    expect(computeService.testFiles.contract).toEqual(
      expect.arrayContaining([
        'src/main/application-command-composition.test.ts',
        'src/main/compute/job-dispatcher.test.ts',
        'src/main/compute/job-poller.test.ts',
        'src/main/compute/job-repository.test.ts',
        'src/main/compute/ipc.test.ts',
        'src/main/compute/application-commands.test.ts',
        'src/main/notebook/local-rpc-server.mcpcall.test.ts',
        'src/main/notebook/local-rpc-server.test.ts',
        'src/shared/remote-fs.test.ts',
        'src/preload/index.test.ts',
        'src/renderer/web/api-installer.test.ts',
        'src/shared/renderer-contract-catalog.test.ts'
      ])
    )
  })

  it('keeps Probe transport and SSH configuration selection behind the Broker seam', () => {
    const owner = readSource(computePaths.hostOwner)
    expect(owner).toContain("intent: 'probe'")
    expect(owner).toContain('connectionBroker.acquire')
    expect(owner).not.toContain("from './ssh-runner'")
    expect(owner).not.toContain('resolveSshTarget')

    const broker = readSource(computePaths.connectionBroker)
    expect(broker).toContain('resolveSshTarget')
    expect(broker).toContain('runner.run')
  })

  it('filters Compute Host access when a lazy Session is opened', () => {
    const mainIpc = readSource(resolve(mainRoot, 'composition/session-projection.ts'))
    expect(mainIpc).toContain(
      'sessionEnabledComputeHostsOwnerRef.current.reconcileSession(session)'
    )
    expect(mainIpc).not.toContain('sessionEnabledComputeHostsOwnerRef.current?.project(session)')
  })
})
