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
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isStringLiteralLike,
  ScriptKind,
  ScriptTarget,
  type SourceFile,
  SyntaxKind,
  type Node
} from 'typescript'
import { describe, expect, it } from 'vitest'

import { RENDERER_CONTRACT_CATALOG } from '../../shared/renderer-contract-catalog'

const projectRoot = resolve(__dirname, '../../..')
const mainRoot = resolve(projectRoot, 'src/main')
const manifestPath = resolve(projectRoot, 'scripts/ci/module-impact.json')
const architectureTestPath = 'src/main/compute/compute-service.architecture.test.ts'
const computePaths = {
  connectionBroker: resolve(mainRoot, 'compute/connection-broker.ts'),
  facade: resolve(mainRoot, 'compute/compute-service.ts'),
  hostOwner: resolve(mainRoot, 'compute/compute-host-profile-owner.ts'),
  remoteOwner: resolve(mainRoot, 'compute/compute-remote-operation-owner.ts'),
  jobOwner: resolve(mainRoot, 'compute/compute-job-workflow-owner.ts'),
  deletionOwner: resolve(mainRoot, 'compute/job-deletion-owner.ts'),
  jobLifecycle: resolve(mainRoot, 'compute/compute-job-lifecycle.ts'),
  jobRepository: resolve(mainRoot, 'compute/job-repository.ts'),
  concurrencyManager: resolve(mainRoot, 'compute/concurrency-manager.ts'),
  jobDispatcher: resolve(mainRoot, 'compute/job-dispatcher.ts'),
  jobPoller: resolve(mainRoot, 'compute/job-poller.ts'),
  sessionEnabledHostsOwner: resolve(mainRoot, 'compute/session-enabled-hosts-owner.ts'),
  ipc: resolve(mainRoot, 'compute/ipc.ts'),
  electronIpcAdapter: resolve(mainRoot, 'compute/electron-ipc-adapter.ts'),
  mainIpc: resolve(mainRoot, 'ipc.ts'),
  applicationCommands: resolve(mainRoot, 'compute/application-commands.ts'),
  jobRuntime: resolve(mainRoot, 'compute/job-runtime.ts'),
  localRpc: resolve(mainRoot, 'notebook/local-rpc-server.ts')
} as const

const readSource = (path: string): string => readFileSync(path, 'utf8')
const rawLineCount = (source: string): number => source.trimEnd().split(/\r?\n/).length
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
const lifecyclePaths = [
  computePaths.deletionOwner,
  computePaths.jobLifecycle,
  computePaths.jobRepository,
  computePaths.concurrencyManager,
  computePaths.jobDispatcher,
  computePaths.jobPoller
] as const
const productionSourcePaths = productionSources()

describe('Compute service architecture', () => {
  it('keeps the facade and private owners within their completion gates', () => {
    expect(rawLineCount(readSource(computePaths.facade))).toBeLessThanOrEqual(600)
    for (const ownerPath of privateOwnerPaths) {
      expect(
        rawLineCount(readSource(ownerPath)),
        portableProjectPath(ownerPath)
      ).toBeLessThanOrEqual(660)
    }
    expect(rawLineCount(readSource(computePaths.sessionEnabledHostsOwner))).toBeLessThanOrEqual(660)
    for (const lifecyclePath of lifecyclePaths) {
      expect(
        rawLineCount(readSource(lifecyclePath)),
        portableProjectPath(lifecyclePath)
      ).toBeLessThanOrEqual(660)
    }
    expect(rawLineCount(readSource(computePaths.ipc))).toBeLessThanOrEqual(660)
    expect(rawLineCount(readSource(computePaths.electronIpcAdapter))).toBeLessThanOrEqual(660)
  })

  it('wires facade collaborators by name instead of positional optional arguments', () => {
    const facade = readSource(computePaths.facade)
    expect(facade).toContain('constructor(dependencies: ComputeServiceDependencies)')
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
        'finishPolled',
        'observeRunning',
        'promoteQueued',
        'recordPollError',
        'recoverInterruptedDispatch'
      ].sort()
    )
    expect(calledMembersOn(computePaths.jobLifecycle, ['this', 'repository'])).toEqual(
      ['abortOwnerDeletion', 'beginOwnerDeletion', 'deleteByOwner', 'updateIfStatus'].sort()
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
      'src/main/compute/job-poller.ts'
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
      'await projectDeletionCoordinator.restorePendingDeletionBarriers()'
    )
    const jobBarriers = source.indexOf(
      'await jobDeletionOwner.restoreOrphanJobDeletionBarriers',
      projectBarriers
    )
    const runtimeStart = source.indexOf('const jobPoller = createComputeJobRuntime', jobBarriers)
    const backgroundRecovery = source.indexOf(
      'const projectDeletionRecovery = new ProjectDeletionRecoveryLoop',
      runtimeStart
    )
    const projectOrphanRecovery = source.indexOf(
      'await deletionOwner.reconcileProjectOrphanJobs(projectId, isComputeJobOwnerLive)'
    )
    const backgroundOrphanRecovery = source.indexOf(
      'await jobDeletionOwner.reconcileOrphanJobs(isComputeJobOwnerLive)',
      backgroundRecovery
    )
    const backgroundSessionRecovery = source.indexOf(
      'await sessionRepository.reconcilePendingSessionProjection()',
      backgroundOrphanRecovery
    )
    const backgroundProjectRecovery = source.indexOf(
      'await projectDeletionCoordinator.recoverPendingDeletions()',
      backgroundSessionRecovery
    )

    expect(projectBarriers).toBeGreaterThan(-1)
    expect(jobBarriers).toBeGreaterThan(projectBarriers)
    expect(runtimeStart).toBeGreaterThan(jobBarriers)
    expect(backgroundRecovery).toBeGreaterThan(runtimeStart)
    expect(projectOrphanRecovery).toBeGreaterThan(-1)
    expect(backgroundOrphanRecovery).toBeGreaterThan(backgroundRecovery)
    expect(backgroundSessionRecovery).toBeGreaterThan(backgroundOrphanRecovery)
    expect(backgroundProjectRecovery).toBeGreaterThan(backgroundSessionRecovery)
  })

  it('gives Compute Job shutdown the transport cancellation budget', () => {
    const source = readSource(computePaths.mainIpc)
    const runtimeStart = source.indexOf('const jobPoller = createComputeJobRuntime')
    const runtimeEnd = source.indexOf('const agentComputeService', runtimeStart)
    const runtimeRegistration = source.slice(runtimeStart, runtimeEnd)

    expect(runtimeStart).toBeGreaterThan(-1)
    expect(runtimeEnd).toBeGreaterThan(runtimeStart)
    expect(runtimeRegistration).toContain('disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS')
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
        'callCommand',
        'download',
        'getDetails',
        'getJobResult',
        'getJobStatus',
        'getSessionConcurrencyStatus',
        'handleJobUpdated',
        'list',
        'listDir',
        'probe',
        'replaceDetails',
        'setConcurrencyLimit',
        'setScratchRoot',
        'setSessionConcurrencyLimit',
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
      'handleJobUpdated'
    ])
  })

  it('keeps the Session-bound local RPC capability on its established facade operations', () => {
    expect(calledMembersOn(computePaths.localRpc, ['this', 'computeService'])).toEqual([
      'appendDetails',
      'callCommand',
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
    expect(computeContracts).toHaveLength(33)
    const remoteRestricted = computeContracts.filter(
      ({ surfaceInstallation }) => surfaceInstallation.remoteWeb === 'rejecting-stub'
    )
    expect(remoteRestricted.map(({ channel }) => channel).sort()).toEqual([
      'compute:change-authentication',
      'compute:create-password',
      'compute:download',
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
    const manifest = JSON.parse(readSource(manifestPath)) as {
      modules: {
        compute_service: {
          ownerPaths: string[]
          interfacePaths: string[]
          testFiles: { owner: string[]; contract: string[]; consumer: string[] }
        }
      }
    }
    const computeService = manifest.modules.compute_service

    expect(computeService.ownerPaths).toEqual([
      'src/main/compute/approval-session-lifecycle.ts',
      'src/main/compute/agent-compute-service.ts',
      'src/main/compute/compute-approval-broker.ts',
      'src/main/compute/compute-host-profile-owner.ts',
      'src/main/compute/compute-job-lifecycle.ts',
      'src/main/compute/job-deletion-owner.ts',
      'src/main/compute/compute-job-workflow-owner.ts',
      'src/main/compute/compute-remote-operation-owner.ts',
      'src/main/compute/concurrency-manager.ts',
      'src/main/compute/job-dispatcher.ts',
      'src/main/compute/job-poller.ts',
      'src/main/compute/job-poll-output.ts',
      'src/main/compute/job-repository.ts',
      'src/main/compute/enabled-hosts-registry.ts',
      'src/main/compute/session-enabled-hosts-owner.ts',
      'src/main/compute/permission-grant-adapter.ts',
      'src/main/compute/compute-auth-owner.ts',
      'src/main/compute/connection-adapters.ts',
      'src/main/compute/credential-vault.ts',
      'src/main/compute/compute-service.ts'
    ])
    expect(computeService.interfacePaths).toEqual([
      'src/main/compute/connection-broker.ts',
      'src/main/compute/compute-service.ts',
      'src/main/compute/ipc.ts',
      'src/main/compute/electron-ipc-adapter.ts'
    ])
    expect(computeService.testFiles.owner).toEqual(
      expect.arrayContaining([
        architectureTestPath,
        'src/main/compute/approval-session-lifecycle.test.ts',
        'src/main/compute/agent-compute-service.test.ts',
        'src/main/compute/compute-approval-broker.test.ts',
        'src/main/compute/connection-broker.test.ts',
        'src/main/compute/compute-job-lifecycle.test.ts',
        'src/main/compute/job-deletion-owner.test.ts',
        'src/main/compute/session-enabled-hosts-owner.test.ts',
        'src/main/compute/compute-host-profile-owner.test.ts',
        'src/main/compute/compute-job-workflow-owner.test.ts',
        'src/main/compute/compute-remote-operation-owner.test.ts',
        'src/main/compute/permission-grant-adapter.test.ts',
        'src/main/compute/compute-service.test.ts',
        'src/main/compute/compute-auth-owner.test.ts',
        'src/main/compute/credential-vault.test.ts',
        'src/main/compute/compute-password-auth.architecture.test.ts'
      ])
    )
    expect(computeService.testFiles.contract).toEqual(
      expect.arrayContaining([
        'src/main/application-command-composition.test.ts',
        'src/main/compute/application-commands.test.ts',
        'src/main/compute/concurrency-manager.test.ts',
        'src/main/compute/ipc.test.ts',
        'src/main/compute/job-dispatcher.test.ts',
        'src/main/compute/job-poller.test.ts',
        'src/main/notebook/local-rpc-server.mcpcall.test.ts',
        'src/main/notebook/local-rpc-server.test.ts'
      ])
    )
    expect(computeService.testFiles.consumer).toEqual(
      expect.arrayContaining([
        'src/main/compute/enabled-hosts-registry.test.ts',
        'src/main/compute/job-runtime.test.ts'
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
    const mainIpc = readSource(computePaths.mainIpc)
    expect(mainIpc).toContain(
      'sessionEnabledComputeHostsOwnerRef.current.reconcileSession(session)'
    )
    expect(mainIpc).not.toContain('sessionEnabledComputeHostsOwnerRef.current?.project(session)')
  })
})
