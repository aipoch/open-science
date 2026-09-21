import { readFileSync, readdirSync } from 'node:fs'
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
  isPropertyDeclaration,
  isPropertyAccessExpression,
  isStringLiteralLike,
  ScriptKind,
  ScriptTarget,
  type SourceFile,
  SyntaxKind,
  type Node
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
  mainIpc: resolve(mainRoot, 'ipc.ts'),
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

  it('keeps lifecycle state ownership behind the narrow intent interface', () => {
    const lifecycle = sourceFileFor(computePaths.jobLifecycle).statements.find(
      (statement) => isClassDeclaration(statement) && statement.name?.text === 'ComputeJobLifecycle'
    )
    expect(lifecycle && isClassDeclaration(lifecycle)).toBe(true)
    if (!lifecycle || !isClassDeclaration(lifecycle)) return

    const publicMethods = lifecycle.members
      .flatMap((member) => {
        if (
          !isMethodDeclaration(member) ||
          !isIdentifier(member.name) ||
          getModifiers(member)?.some((modifier) => modifier.kind === SyntaxKind.PrivateKeyword) ===
            true
        ) {
          return []
        }
        return [member.name.text]
      })
      .sort()
    expect(publicMethods).toEqual(
      [
        'abortOwnerDeletion',
        'beginOwnerDeletion',
        'deleteOwnerRows',
        'dispatchError',
        'dispatchRunning',
        'dispatchSubmitted',
        'failRemoteHandleRecovery',
        'finishPolled',
        'observeRunning',
        'promoteQueued',
        'recordPollError',
        'recoverRemoteHandle',
        'recoverInterruptedDispatch'
      ].sort()
    )
    expect(calledMembersOn(computePaths.jobLifecycle, ['this', 'repository'])).toEqual(
      [
        'abortOwnerDeletion',
        'beginOwnerDeletion',
        'deleteByOwner',
        'recordCancellationHandle',
        'updateIfStatus'
      ].sort()
    )

    const lifecycleTarget = modulePath(computePaths.jobLifecycle)
    const importers = productionSourcePaths.flatMap((sourcePath) =>
      importSpecifiersFrom(sourcePath).some(
        (specifier) => resolveImportTarget(sourcePath, specifier) === lifecycleTarget
      )
        ? [portableProjectPath(sourcePath)]
        : []
    )
    expect(importers).toEqual([
      'src/main/compute/concurrency-manager.ts',
      'src/main/compute/job-deletion-owner.ts',
      'src/main/compute/job-dispatcher.ts',
      'src/main/compute/job-poller.ts',
      'src/main/compute/submitted-job-recovery.ts'
    ])

    for (const calls of [
      calledMembersOn(computePaths.concurrencyManager, ['this', 'jobRepository']),
      calledMembersOn(computePaths.jobDispatcher, ['jobRepository']),
      calledMembersOn(computePaths.jobPoller, ['this', 'deps', 'jobRepository'])
    ]) {
      expect(calls).not.toContain('update')
      expect(calls).not.toContain('updateIfStatus')
    }
  })

  it('restores local owner barriers before runtime and defers remote recovery until after startup', () => {
    const source = readSource(computePaths.mainIpc)
    const projectBarriers = source.indexOf(
      'projectDeletionCoordinator.restorePendingDeletionBarriers()'
    )
    const jobBarriers = source.indexOf(
      'await jobDeletionOwner.restoreOrphanJobDeletionBarriers',
      projectBarriers
    )
    const runtimeStart = source.indexOf('const jobPoller = createComputeJobRuntime', jobBarriers)
    const projectRuntimeReady = source.indexOf(
      'projectRuntimeQuiescenceRef.current = new ProjectRuntimeQuiescenceOwner'
    )
    const backgroundRecovery = source.indexOf(
      'const projectDeletionRecovery = new ProjectDeletionRecoveryLoop',
      runtimeStart
    )
    const projectOrphanRecovery = source.indexOf(
      'await deletionOwner.reconcileProjectOrphanJobs(projectId, isComputeJobOwnerLive)'
    )
    const backgroundOrphanRecovery = source.indexOf(
      'recoverOrphanJobs: () => jobDeletionOwner.reconcileOrphanJobs(isComputeJobOwnerLive)',
      backgroundRecovery
    )
    const backgroundSessionRecovery = source.indexOf(
      'replaySessionProjection: () => sessionRepository.reconcilePendingSessionProjection()',
      backgroundOrphanRecovery
    )
    const backgroundProjectRecovery = source.indexOf(
      'recoverProjects: () => projectDeletionCoordinator.recoverPendingDeletions()',
      backgroundSessionRecovery
    )
    const committedDeletionWake = source.indexOf(
      "event.payload.status === 'cleanup-pending'",
      backgroundProjectRecovery
    )
    const wakeCall = source.indexOf('projectDeletionRecovery.wake()', committedDeletionWake)

    expect(projectBarriers).toBeGreaterThan(-1)
    expect(jobBarriers).toBeGreaterThan(projectBarriers)
    expect(projectRuntimeReady).toBeGreaterThan(jobBarriers)
    expect(runtimeStart).toBeGreaterThan(projectRuntimeReady)
    expect(backgroundRecovery).toBeGreaterThan(runtimeStart)
    expect(projectOrphanRecovery).toBeGreaterThan(-1)
    expect(backgroundOrphanRecovery).toBeGreaterThan(backgroundRecovery)
    expect(backgroundSessionRecovery).toBeGreaterThan(backgroundOrphanRecovery)
    expect(backgroundProjectRecovery).toBeGreaterThan(backgroundSessionRecovery)
    expect(committedDeletionWake).toBeGreaterThan(backgroundProjectRecovery)
    expect(wakeCall).toBeGreaterThan(committedDeletionWake)
  })

  it('gives Compute Job shutdown the transport cancellation budget', () => {
    const source = readSource(computePaths.mainIpc)
    const runtimeStart = source.indexOf('const jobPoller = createComputeJobRuntime')
    const runtimeEnd = source.indexOf(
      'const projectDeletionRecovery = new ProjectDeletionRecoveryLoop',
      runtimeStart
    )
    const runtimeRegistration = source.slice(runtimeStart, runtimeEnd)

    expect(runtimeStart).toBeGreaterThan(-1)
    expect(runtimeEnd).toBeGreaterThan(runtimeStart)
    expect(runtimeRegistration).toContain('disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS')
  })

  it('resolves Compute policy without entering Session catalog hydration or coordinator locks', () => {
    const source = readSource(computePaths.mainIpc)
    const start = source.indexOf('const sessionLimitPersistence = {')
    const write = source.indexOf('save: async', start)
    const resolver = source.slice(start, write)
    expect(resolver).toContain('sessionRepository.loadComputePolicy')
    expect(resolver).not.toContain('loadAllSessions')
    expect(resolver).not.toContain('sessionPersistenceCoordinator')
    expect(resolver).not.toContain('canReconcileSessionAbsences')
  })

  it('persists Session concurrency limits inside the data-root write boundary', () => {
    const source = readSource(computePaths.mainIpc)
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
    const source = readSource(computePaths.mainIpc)
    const abortStart = source.indexOf('abortProjectDeletion: async (projectId) => {')
    const abortEnd = source.indexOf('const detectArchiveBlockingSessions', abortStart)
    const abortSource = source.slice(abortStart, abortEnd)

    expect(abortStart).toBeGreaterThan(-1)
    expect(abortEnd).toBeGreaterThan(abortStart)
    expect(abortSource).toContain('await computeJobDeletionPort.abortProjectJobDeletion(projectId)')
  })

  it('treats unreadable Session authority as unknown during Compute Job recovery', () => {
    const source = readSource(computePaths.mainIpc)
    const livenessStart = source.indexOf('const isComputeJobOwnerLive')
    const livenessEnd = source.indexOf('const computeJobDeletionRef', livenessStart)
    const livenessSource = source.slice(livenessStart, livenessEnd)

    expect(livenessStart).toBeGreaterThan(-1)
    expect(livenessEnd).toBeGreaterThan(livenessStart)
    expect(livenessSource).toContain("return 'unknown'")
    expect(livenessSource).not.toContain('throw new Error')
    expect(source).toContain('restoreOrphanJobDeletionBarriers(isComputeJobOwnerLive)')
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
      ).toEqual(['src/main/compute/compute-service.ts'])
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
    expect(importedNamesFrom(computePaths.ipc, computePaths.facade)).toEqual([
      'ArtifactResolver',
      'ComputeService'
    ])
    expect(importedNamesFrom(computePaths.jobRuntime, computePaths.facade)).toEqual([
      'ComputeService'
    ])
    expect(importedNamesFrom(computePaths.applicationCommands, computePaths.ipc)).toEqual([
      'ComputeHandlers'
    ])

    expect(referencedMembersOn(computePaths.jobRuntime, ['deps', 'computeService'])).toEqual([
      'bindJobHarvestRetry',
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

    expect(computeService.ownerPaths).toEqual([
      'src/main/compute/approval-session-lifecycle.ts',
      'src/main/compute/agent-compute-service.ts',
      'src/main/compute/bounded-child-termination.ts',
      'src/main/compute/compute-approval-broker.ts',
      'src/main/compute/compute-host-profile-owner.ts',
      'src/main/compute/compute-job-lifecycle.ts',
      'src/main/compute/job-deletion-owner.ts',
      'src/main/compute/compute-job-workflow-owner.ts',
      'src/main/compute/compute-job-status.ts',
      'src/main/compute/compute-job-cancellation-owner.ts',
      'src/main/compute/compute-job-operation-repository.ts',
      'src/main/compute/compute-remote-operation-owner.ts',
      'src/main/compute/concurrency-manager.ts',
      'src/main/compute/job-dispatcher.ts',
      'src/main/compute/job-poller.ts',
      'src/main/compute/job-poll-output.ts',
      'src/main/compute/job-runtime.ts',
      'src/main/compute/job-notifier.ts',
      'src/main/compute/job-harvest-scheduler.ts',
      'src/main/compute/harvest-engine.ts',
      'src/main/compute/compute-job-integrity.ts',
      'src/main/compute/job-repository.ts',
      'src/main/compute/remote-job-process.ts',
      'src/main/compute/remote-job-handle.ts',
      'src/main/compute/remote-launch-recovery.ts',
      'src/main/compute/submitted-job-recovery.ts',
      'src/main/compute/enabled-hosts-registry.ts',
      'src/main/compute/session-enabled-hosts-owner.ts',
      'src/main/compute/permission-grant-adapter.ts',
      'src/main/compute/repository.ts',
      'src/main/compute/scp-runner.ts',
      'src/main/compute/session-cache-owner.ts',
      'src/main/compute/ssh-runner.ts',
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
      'src/main/compute/compute-environment.test.ts',
      'src/main/compute/compute-environment.ts',
      'src/main/compute/compute-host-deletion-owner.ts',
      'src/main/compute/compute-host-profile-concurrency.test.ts',
      'src/main/compute/compute-host-profile-owner.test.ts',
      'src/main/compute/compute-integration.test-support.ts',
      'src/main/compute/compute-job-cancellation-owner.integration.test.ts',
      'src/main/compute/cancellation-runtime.integration.test.ts',
      'src/main/compute/cancellation.real-ssh.integration.test.ts',
      'src/main/compute/remote-job-process.test.ts',
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
      'src/main/compute/concurrency-manager.test.ts',
      'src/main/compute/connection-broker.test.ts',
      'src/main/compute/connection-broker.ts',
      'src/main/compute/credential-vault.test.ts',
      'src/main/compute/dispatch-tracker.test.ts',
      'src/main/compute/dispatch-tracker.ts',
      'src/main/compute/electron-ipc-adapter.ts',
      'src/main/compute/enabled-hosts-registry.test.ts',
      'src/main/compute/harvest-classifier.test.ts',
      'src/main/compute/harvest-classifier.ts',
      'src/main/compute/harvest-engine.test.ts',
      'src/main/compute/ipc.test.ts',
      'src/main/compute/ipc.ts',
      'src/main/compute/job-deletion-owner.test.ts',
      'src/main/compute/job-deletion-runtime-drain.test.ts',
      'src/main/compute/job-deletion-runtime-isolation.test-support.ts',
      'src/main/compute/job-deletion-runtime-isolation.test.ts',
      'src/main/compute/job-dispatcher.test.ts',
      'src/main/compute/job-notifier.integration.test.ts',
      'src/main/compute/job-notifier.test.ts',
      'src/main/compute/job-poll-output.test.ts',
      'src/main/compute/job-poll-protocol.integration.test.ts',
      'src/main/compute/job-poller.test.ts',
      'src/main/compute/job-recovery-regressions.integration.test.ts',
      'src/main/compute/job-repository.test.ts',
      'src/main/compute/job-runtime.test.ts',
      'src/main/compute/permission-grant-adapter.test.ts',
      'src/main/compute/prisma-client.test.ts',
      'src/main/compute/remote-compute-skill.test.ts',
      'src/main/compute/remote-file-snapshot.ts',
      'src/main/compute/remote-job-contract.ts',
      'src/main/compute/remote-job-handle.test.ts',
      'src/main/compute/remote-path-security.ts',
      'src/main/compute/repository.test.ts',
      'src/main/compute/scp-runner.test.ts',
      'src/main/compute/session-cache-owner.test.ts',
      'src/main/compute/session-catalog-hydration.integration.test.ts',
      'src/main/compute/session-catalog-hydration.ts',
      'src/main/compute/session-compute-host-access.test.ts',
      'src/main/compute/session-compute-host-access.ts',
      'src/main/compute/session-enabled-hosts-owner.test.ts',
      'src/main/compute/skill-doc.test.ts',
      'src/main/compute/skill-doc.ts',
      'src/main/compute/skill-provisioning.test.ts',
      'src/main/compute/slurm-driver-boundaries.test.ts',
      'src/main/compute/slurm-driver.ts',
      'src/main/compute/slurm.real-ssh.integration.test.ts',
      'src/main/compute/ssh-config.test.ts',
      'src/main/compute/ssh-config.ts',
      'src/main/compute/ssh-runner.test.ts',
      'src/main/compute/workspace-path.ts',
      'src/renderer/src/lib/compute/WorkspaceComputeRecoveryBridge.render.test.tsx',
      'src/renderer/src/lib/compute/job-analysis-trigger.test.ts',
      'src/renderer/src/lib/compute/useJobAnalysisEffect.render.test.tsx',
      'src/renderer/src/lib/compute/useSessionJobHydration.render.test.tsx'
    ])
    expect(computeService.interfacePaths).toEqual([
      'src/main/compute/connection-broker.ts',
      'src/main/compute/compute-service.ts',
      'src/main/compute/ipc.ts',
      'src/main/compute/electron-ipc-adapter.ts',
      'src/renderer/src/lib/compute/useJobAnalysisEffect.ts',
      'src/main/compute/agent-compute-service.ts',
      'src/main/compute/application-commands.ts',
      'src/main/compute/approval-session-lifecycle.ts',
      'src/main/compute/compute-approval-broker.ts',
      'src/main/compute/compute-job-lifecycle.ts',
      'src/main/compute/compute-job-operation-repository.ts',
      'src/main/compute/compute-job-workflow-owner.ts',
      'src/main/compute/compute-remote-operation-owner.ts',
      'src/main/compute/concurrency-manager.ts',
      'src/main/compute/enabled-hosts-registry.ts',
      'src/main/compute/job-deletion-owner.ts',
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
    expect(computeService.consumerModules).toEqual(['workspace_page'])
    expect(computeService.testFiles.owner).toEqual([
      'src/main/compute/approval-session-lifecycle.test.ts',
      'src/main/compute/agent-compute-service.test.ts',
      'src/main/compute/agent-no-list-jobs.test.ts',
      'src/main/compute/compute-approval-broker.test.ts',
      'src/main/compute/compute-job-lifecycle.test.ts',
      'src/main/compute/job-deletion-owner.test.ts',
      'src/main/compute/compute-service.architecture.test.ts',
      'src/main/compute/compute-host-profile-owner.test.ts',
      'src/main/compute/compute-job-workflow-owner.test.ts',
      'src/main/compute/compute-job-cancellation-owner.integration.test.ts',
      'src/main/compute/cancellation-runtime.integration.test.ts',
      'src/main/compute/cancellation.real-ssh.integration.test.ts',
      'src/main/compute/remote-job-process.test.ts',
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
      'src/main/compute/remote-job-handle.test.ts',
      'src/main/compute/remote-compute-skill.test.ts',
      'src/renderer/src/lib/compute/WorkspaceComputeRecoveryBridge.render.test.tsx',
      'src/renderer/src/lib/compute/job-analysis-trigger.test.ts',
      'src/renderer/src/lib/compute/useJobAnalysisEffect.render.test.tsx',
      'src/renderer/src/lib/compute/useSessionJobHydration.render.test.tsx',
      'src/main/compute/authentication-runtime.test.ts',
      'src/main/compute/compute-environment.test.ts',
      'src/main/compute/compute-host-profile-concurrency.test.ts',
      'src/main/compute/compute-password-auth.real-ssh.integration.test.ts',
      'src/main/compute/compute-password-auth.release.test.ts',
      'src/main/compute/compute-probe-script.test.ts',
      'src/main/compute/dispatch-tracker.test.ts',
      'src/main/compute/harvest-classifier.test.ts',
      'src/main/compute/prisma-client.test.ts',
      'src/main/compute/session-catalog-hydration.integration.test.ts',
      'src/main/compute/session-compute-host-access.test.ts',
      'src/main/compute/skill-doc.test.ts',
      'src/main/compute/skill-provisioning.test.ts',
      'src/main/compute/slurm-driver-boundaries.test.ts',
      'src/main/compute/slurm.real-ssh.integration.test.ts',
      'src/main/compute/ssh-config.test.ts'
    ])
    expect(computeService.testFiles.contract).toEqual([
      'src/main/application-command-composition.test.ts',
      'src/main/compute/concurrency-manager.test.ts',
      'src/main/compute/job-dispatcher.test.ts',
      'src/main/compute/job-poller.test.ts',
      'src/main/compute/job-poll-output.test.ts',
      'src/main/compute/job-repository.test.ts',
      'src/main/compute/scp-runner.test.ts',
      'src/main/compute/ssh-runner.test.ts',
      'src/main/compute/ipc.test.ts',
      'src/main/compute/application-commands.test.ts',
      'src/main/notebook/local-rpc-server.mcpcall.test.ts',
      'src/main/notebook/local-rpc-server.test.ts',
      'src/shared/remote-fs.test.ts',
      'src/preload/index.test.ts',
      'src/renderer/web/api-installer.test.ts',
      'src/shared/renderer-contract-catalog.test.ts'
    ])
    expect(computeService.testFiles.consumer).toEqual([
      'src/main/session-persistence/runtime-session-owner.test.ts',
      'src/main/session-plan/adversarial-session-plan.test.ts',
      'src/main/compute/job-runtime.test.ts',
      'src/main/compute/enabled-hosts-registry.test.ts',
      'src/main/acp/application-commands.test.ts',
      'src/main/acp/artifact-code-reconstruction-runner.test.ts',
      'src/main/acp/codex-completion-handoff.integration.test.ts',
      'src/main/acp/context-compaction-workflow.test.ts',
      'src/main/acp/context-usage-policy.test.ts',
      'src/main/acp/durable-continuation-context-owner.test.ts',
      'src/main/acp/file-reference-resolver.test.ts',
      'src/main/acp/file-reference-resolver.windows-scope.test.ts',
      'src/main/acp/image-input-compatibility-owner.test.ts',
      'src/main/acp/ipc.test.ts',
      'src/main/acp/isolated-execution-preflight.test.ts',
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
      'src/main/acp/turn-skill-owner.test.ts',
      'src/main/agents/agents-repl.integration.test.ts',
      'src/main/agents/agents-repl.mutations.integration.test.ts',
      'src/main/agents/agents-repl.privileged.integration.test.ts',
      'src/main/agents/agents-repl.runtime-consumption.integration.test.ts',
      'src/main/agents/app-handoff-runtime.integration.test.ts',
      'src/main/agents/completion-gate.execute-control.integration.test.ts',
      'src/main/agents/completion-gate.integration.test.ts',
      'src/main/application-command-client.test.ts',
      'src/main/application-command-electron-adapter.test.ts',
      'src/main/artifacts/artifact-provenance-graph.test.ts',
      'src/main/artifacts/artifact-save.integration.test.ts',
      'src/main/artifacts/code-reconstruction.test.ts',
      'src/main/artifacts/ipc.test.ts',
      'src/main/artifacts/literature-manifest.test.ts',
      'src/main/artifacts/mcp-server.test.ts',
      'src/main/artifacts/provenance-dependency-read.test.ts',
      'src/main/artifacts/provenance-helper-evidence.test.ts',
      'src/main/artifacts/provenance-lifecycle-contract.test.ts',
      'src/main/artifacts/provenance-message-snapshot.test.ts',
      'src/main/artifacts/provenance-repository.test.ts',
      'src/main/artifacts/provenance-startup.integration.test.ts',
      'src/main/artifacts/provenance-write-contract.test.ts',
      'src/main/bookmarks/pdf-source-diagnostics.test.ts',
      'src/main/bookmarks/service.test.ts',
      'src/main/connectors/application.test.ts',
      'src/main/data-content-application-commands.test.ts',
      'src/main/database/literature-inbox-integrity-migration.test.ts',
      'src/main/database/managed-file-version-domain.test.ts',
      'src/main/database/migration-service.test.ts',
      'src/main/delegation/production-composition.test.ts',
      'src/main/delegation/production-framework-runtime.test.ts',
      'src/main/delegation/session-record-adapter.test.ts',
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
      'src/main/managed-file-versions/diff-task.test.ts',
      'src/main/managed-file-versions/ipc.test.ts',
      'src/main/managed-file-versions/service.integration.test.ts',
      'src/main/managed-preview-ipc.test.ts',
      'src/main/managed-preview-protocol.test.ts',
      'src/main/managed-preview-resources.test.ts',
      'src/main/notebook/delegated-lane-capability.test.ts',
      'src/main/notebook/e2e.certification.test.ts',
      'src/main/notebook/host-artifacts-service.test.ts',
      'src/main/notebook/host-compute.integration.test.ts',
      'src/main/notebook/host-mcp.integration.test.ts',
      'src/main/notebook/host-model-service.test.ts',
      'src/main/notebook/input-registry.test.ts',
      'src/main/notebook/local-rpc-server.agents.test.ts',
      'src/main/notebook/local-rpc-server.artifacts.test.ts',
      'src/main/notebook/local-rpc-server.capabilities.test.ts',
      'src/main/notebook/local-rpc-server.delegated-work.test.ts',
      'src/main/notebook/local-rpc-server.errors.test.ts',
      'src/main/notebook/local-rpc-server.frames.test.ts',
      'src/main/notebook/local-rpc-server.lineage.test.ts',
      'src/main/notebook/local-rpc-server.llm.test.ts',
      'src/main/notebook/local-rpc-server.models.test.ts',
      'src/main/notebook/local-rpc-server.sessions.test.ts',
      'src/main/notebook/local-rpc-server.skill-import.test.ts',
      'src/main/notebook/local-rpc-server.skills.test.ts',
      'src/main/notebook/local-rpc-server.user-input.test.ts',
      'src/main/notebook/local-rpc-server.wsl-setup.test.ts',
      'src/main/notebook/mcp-management-lifecycle.integration.test.ts',
      'src/main/notebook/mcp-server.test.ts',
      'src/main/notebook/no-legacy-bridge.test.ts',
      'src/main/notebook/repl-loop.integration.test.ts',
      'src/main/notifications/electron-wiring.test.ts',
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
      'src/main/session-persistence/artifact-finalization-recovery.integration.test.ts',
      'src/main/session-persistence/claude-replay.test.ts',
      'src/main/session-persistence/compute-policy.test.ts',
      'src/main/session-persistence/coordinator-contract.test.ts',
      'src/main/session-persistence/coordinator.test.ts',
      'src/main/session-persistence/delegated-work-records.test.ts',
      'src/main/session-persistence/deletion-integration.test.ts',
      'src/main/session-persistence/ipc.test.ts',
      'src/main/session-persistence/pdf-context-owner.test.ts',
      'src/main/session-persistence/projection.test.ts',
      'src/main/session-persistence/runtime-lookup.test.ts',
      'src/main/session-plan/plan-service.test.ts',
      'src/main/session-plan/production-plan-service.test.ts',
      'src/main/settings/agent-runtime-manager.test.ts',
      'src/main/settings/application-commands.test.ts',
      'src/main/settings/backend-resolver.test.ts',
      'src/main/settings/bootstrap.integration.test.ts',
      'src/main/settings/claude-runtime-provisioner.test.ts',
      'src/main/settings/connector-credential-recovery.integration.test.ts',
      'src/main/settings/integration-application-commands.test.ts',
      'src/main/settings/ipc.test.ts',
      'src/main/settings/network-proxy-settings.test.ts',
      'src/main/settings/runtime-application-commands.test.ts',
      'src/main/settings/service.connectors.test.ts',
      'src/main/settings/service.providers.test.ts',
      'src/main/settings/service.test.ts',
      'src/main/settings/session-details-model-owner.test.ts',
      'src/main/settings/skill-catalog.python-availability.test.ts',
      'src/main/settings/skill-catalog.registered-helpers.test.ts',
      'src/main/settings/skill-catalog.test.ts',
      'src/main/settings/workflows.test.ts',
      'src/main/settings/workflows/connectors-diagnostic.test.ts',
      'src/main/side-chat/ipc.test.ts',
      'src/main/side-chat/runtime-owner.test.ts',
      'src/main/skills/conversation-import.test.ts',
      'src/main/skills/materializer-integrity.regression.test.ts',
      'src/main/skills/materializer.test.ts',
      'src/main/skills/runtime-mcp-server.test.ts',
      'src/main/specialist/application-commands.test.ts',
      'src/main/specialist/ipc.test.ts',
      'src/main/specialist/specialist-identity-injection.test.ts',
      'src/main/storage/command-owner.atomicity.test.ts',
      'src/main/storage/content-repository.test.ts',
      'src/main/storage/ipc.test.ts',
      'src/main/storage/literature-migration.integration.test.ts',
      'src/main/storage/managed-workspace-ownership.integration.test.ts',
      'src/main/storage/migration-service.test.ts',
      'src/main/storage/provenance-migration-validation.test.ts',
      'src/main/tasks/task-runner.test.ts',
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
      'src/main/window-find-ipc.test.ts',
      'src/renderer/src/App.test.tsx',
      'src/renderer/src/hooks/useLifecycleSync.test.tsx',
      'src/renderer/src/lib/acp/useWorkspaceAgentRuntime.test.ts',
      'src/renderer/src/lib/session-persistence/session-persistence.test.ts',
      'src/renderer/src/main.render.test.tsx',
      'src/renderer/src/pages/literature/LiteratureFullTextLookup.render.test.tsx',
      'src/renderer/src/pages/literature/LiteratureLibraryPage.render.test.tsx',
      'src/renderer/src/pages/literature/LiteratureMetadataEditor.test.tsx',
      'src/renderer/src/pages/workspace/ConversationPanel.interaction.test.tsx',
      'src/renderer/src/pages/workspace/MobilePreviewSheet.annotation.test.tsx',
      'src/renderer/src/pages/workspace/PreviewFileSurface.test.tsx',
      'src/renderer/src/pages/workspace/PreviewPanel.test.tsx',
      'src/renderer/src/pages/workspace/SubagentReleaseSurfaces.render.test.tsx',
      'src/renderer/src/pages/workspace/WorkspaceMessageScroller.annotations.test.tsx',
      'src/renderer/src/pages/workspace/WorkspaceMessageScroller.interaction.test.tsx',
      'src/renderer/src/pages/workspace/WorkspaceMessageScroller.render.test.tsx',
      'src/renderer/src/pages/workspace/WorkspacePage.customize-prefill.test.tsx',
      'src/renderer/src/pages/workspace/WorkspacePage.draft-preservation.test.tsx',
      'src/renderer/src/pages/workspace/WorkspacePage.edit-message.test.tsx',
      'src/renderer/src/pages/workspace/WorkspacePage.image-staging.test.tsx',
      'src/renderer/src/pages/workspace/WorkspacePage.notebook-hydration.test.tsx',
      'src/renderer/src/pages/workspace/WorkspacePage.pending-switch.test.tsx',
      'src/renderer/src/pages/workspace/WorkspacePage.preview-panel-resize.test.tsx',
      'src/renderer/src/pages/workspace/WorkspacePage.send-gate.test.tsx',
      'src/renderer/src/pages/workspace/WorkspacePage.specialist-barrier.test.tsx',
      'src/renderer/src/pages/workspace/artifact-publication-preview.integration.test.tsx',
      'src/renderer/src/pages/workspace/preview-draft-lifecycle.test.tsx',
      'src/renderer/src/pages/workspace/previews/PreviewToolContent.multi-plan-progress.test.tsx',
      'src/renderer/src/pages/workspace/previews/PreviewToolContent.plan-progress-refresh.test.tsx',
      'src/renderer/src/pages/workspace/previews/PreviewToolContent.plan.test.tsx',
      'src/renderer/src/pages/workspace/previews/PreviewToolContent.reviewer.integration.test.tsx',
      'src/renderer/src/pages/workspace/previews/PreviewToolContent.test.tsx',
      'src/renderer/src/pages/workspace/previews/preview-pagination-contract.test.tsx',
      'src/renderer/web/bootstrap.test.ts',
      'src/renderer/web/renderer-argument-shape-characterization.test.ts',
      'src/shared/renderer-surface-inventory.test.ts',
      'src/shared/renderer-surface-matrix.test.ts',
      'src/main/session-package/fork.test.ts',
      'src/main/storage/brand-location.test.ts',
      'src/main/storage/migration-target-race.test.ts',
      'src/renderer/src/components/LegacyDataMoveDialog.storage.test.tsx',
      'src/renderer/src/pages/workspace/workspace-message-queue-controller.test.ts',
      'src/main/session-persistence/runtime-authority.test.ts',
      'src/main/session-persistence/runtime-resume-recovery.test.ts',
      'src/renderer/src/lib/acp/workspace-runtime-interrupted-recovery.test.ts',
      'src/main/artifacts/resumed-finalization-ownership.test.ts',
      'src/main/session-persistence/resumed-artifact-publication.integration.test.ts',
      'src/main/pdf-annotations/repository.integration.test.ts',
      'src/main/pdf-annotations/service.test.ts'
    ])
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
    const mainIpc = readSource(computePaths.mainIpc)
    expect(mainIpc).toContain(
      'sessionEnabledComputeHostsOwnerRef.current.reconcileSession(session)'
    )
    expect(mainIpc).not.toContain('sessionEnabledComputeHostsOwnerRef.current?.project(session)')
  })
})
