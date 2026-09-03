import { describe, expect, it, vi } from 'vitest'

import type { ComputeHost } from '../../shared/compute'
import { decodeRemoteFsError } from '../../shared/remote-fs'
import { RENDERER_CONTRACT_GROUPS } from '../../shared/renderer-contract-catalog'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  createApplicationCommandRouter,
  type ApplicationCallerLease,
  type ApplicationInvocation
} from '../application-command-router'
import {
  createCallerContext,
  createElectronCallerContext,
  createTaskCallerContext,
  createWebCallerContext,
  type CallerContext
} from '../caller-context'
import {
  computeApplicationCommandGroup,
  computeApplicationCommands,
  registerComputeApplicationCommands,
  type ComputeApplicationCommandDependencies,
  type ComputeCommandOwner
} from './application-commands'

const host = { providerId: 'ssh:cluster', displayName: 'Cluster' } as ComputeHost
const session: PersistedChatSession = {
  id: 'session-1',
  projectId: 'project-1',
  title: 'Session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  filesRevision: 1,
  enabledComputeHosts: ['ssh:cluster'],
  createdAt: 1,
  updatedAt: 2
}

const createDependencies = (): ComputeApplicationCommandDependencies => ({
  compute: {
    list: vi.fn(async () => [host]),
    get: vi.fn(async () => host),
    create: vi.fn(async () => host),
    createPassword: vi.fn(async () => ({ ok: true as const, host })),
    resetPassword: vi.fn(async () => ({ ok: true as const, host })),
    changeAuthentication: vi.fn(async () => ({ ok: true as const, host })),
    passwordCapability: vi.fn(async () => ({ available: true })),
    deletionStatus: vi.fn(async () => ({ blockedByJobs: false })),
    delete: vi.fn(async () => undefined),
    sshConfigAliases: vi.fn(async () => ['cluster']),
    probe: vi.fn(async () => ({ ok: true })),
    detailsGet: vi.fn(async () => ({ doc: '# Cluster', isSkeleton: false })),
    detailsSave: vi.fn(async () => undefined),
    scratchSet: vi.fn(async () => undefined),
    scratchClear: vi.fn(async () => undefined),
    concurrencySet: vi.fn(async () => undefined),
    listDir: vi.fn(async () => ({ path: '/work', entries: [] })),
    download: vi.fn(async () => ({ path: '/tmp/result.csv', name: 'result.csv', size: 10 })),
    revealInFolder: vi.fn(() => undefined),
    approvalRespond: vi.fn(() => undefined),
    approvalReplay: vi.fn(() => null),
    approvalReplayPending: vi.fn(() => undefined),
    jobsList: vi.fn(async () => []),
    jobsSetRemoteCleanup: vi.fn(async () => undefined),
    jobsPendingNotification: vi.fn(async () => []),
    jobsMarkConsumed: vi.fn(async () => undefined),
    jobsTransitionAnalysis: vi.fn(async () => [])
  } as unknown as ComputeCommandOwner,
  bookmarks: {
    get: vi.fn(async () => ['/work']),
    set: vi.fn(async () => undefined)
  },
  enabledHosts: {
    get: vi.fn(() => ['ssh:cluster']),
    set: vi.fn(async () => session),
    setHostEnabled: vi.fn(async () => session),
    setHostSelected: vi.fn(async () => session)
  },
  events: { publish: vi.fn() }
})

const invocation = <Args extends readonly unknown[]>(
  args: Args,
  callerContext: CallerContext = createElectronCallerContext(7)
): ApplicationInvocation<Args> => {
  const callerLease: ApplicationCallerLease = Object.freeze({
    leaseId: callerContext.leaseId,
    generation: 1,
    signal: new AbortController().signal,
    isCurrent: () => true
  })
  return Object.freeze({ args, callerContext, callerLease })
}

describe('Compute application commands', () => {
  it('defines exactly the 34 public Compute commands without session-internal handlers', () => {
    const publicComputeChannels = RENDERER_CONTRACT_GROUPS.find(
      (group) => group.capability === 'compute'
    )
      ?.contracts.filter((contract) => contract.kind === 'method')
      .map((contract) => contract.channel)

    expect(publicComputeChannels).toHaveLength(34)
    expect(computeApplicationCommandGroup.commands.map(({ name }) => name)).toEqual(
      publicComputeChannels
    )
    expect(
      computeApplicationCommandGroup.commands.some(({ name }) =>
        name.startsWith('compute:session:')
      )
    ).toBe(false)
  })

  it('delegates every canonical argument tuple to its existing owner', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerComputeApplicationCommands(router.registrar, dependencies)
    const createRequest = { sshAlias: 'cluster', displayName: 'Cluster' }
    const destination = { kind: 'os-downloads' as const }

    await router.dispatcher.invoke(computeApplicationCommands.list, invocation([]))
    await router.dispatcher.invoke(computeApplicationCommands.get, invocation(['ssh:cluster']))
    await router.dispatcher.invoke(computeApplicationCommands.create, invocation([createRequest]))
    const passwordRequest = {
      sshAlias: 'cluster-password',
      authenticationMode: 'password' as const,
      username: 'researcher',
      port: 22,
      password: 'secret',
      operationId: 'operation-1'
    }
    const createPasswordResult = await router.dispatcher.invoke(
      computeApplicationCommands.createPassword,
      invocation([passwordRequest])
    )
    const resetPasswordRequest = {
      providerId: 'ssh:cluster',
      password: 'replacement',
      operationId: 'reset-operation-1',
      expectedAuthenticationRevision: 1
    }
    await router.dispatcher.invoke(
      computeApplicationCommands.resetPassword,
      invocation([resetPasswordRequest])
    )
    const changeRequest = {
      providerId: 'ssh:cluster',
      expectedRevision: 1,
      operationId: 'operation-change-1',
      authenticationMode: 'ssh_config' as const,
      username: 'researcher',
      port: 22
    }
    await router.dispatcher.invoke(
      computeApplicationCommands.changeAuthentication,
      invocation([changeRequest])
    )
    await router.dispatcher.invoke(computeApplicationCommands.passwordCapability, invocation([]))
    await router.dispatcher.invoke(
      computeApplicationCommands.delete,
      invocation([{ providerId: 'ssh:cluster' }])
    )
    await router.dispatcher.invoke(
      computeApplicationCommands.deletionStatus,
      invocation([{ providerId: 'ssh:cluster' }])
    )
    await router.dispatcher.invoke(computeApplicationCommands.sshConfigAliases, invocation([]))
    await router.dispatcher.invoke(computeApplicationCommands.probe, invocation(['ssh:cluster']))
    await router.dispatcher.invoke(
      computeApplicationCommands.detailsGet,
      invocation(['ssh:cluster'])
    )
    await router.dispatcher.invoke(
      computeApplicationCommands.detailsSave,
      invocation(['ssh:cluster', 'new', 'old', 'user'])
    )
    await router.dispatcher.invoke(
      computeApplicationCommands.scratchSet,
      invocation(['ssh:cluster', '/scratch'])
    )
    await router.dispatcher.invoke(
      computeApplicationCommands.scratchClear,
      invocation(['ssh:cluster'])
    )
    await router.dispatcher.invoke(
      computeApplicationCommands.concurrencySet,
      invocation(['ssh:cluster', 8])
    )
    await router.dispatcher.invoke(
      computeApplicationCommands.listDir,
      invocation(['ssh:cluster', '/work'])
    )
    await router.dispatcher.invoke(
      computeApplicationCommands.download,
      invocation(['ssh:cluster', '/work/result.csv', destination])
    )
    await router.dispatcher.invoke(
      computeApplicationCommands.revealInFolder,
      invocation(['/tmp/result.csv'])
    )
    await router.dispatcher.invoke(
      computeApplicationCommands.approvalRespond,
      invocation([{ id: 'approval-1', decision: 'once' }])
    )
    await router.dispatcher.invoke(
      computeApplicationCommands.approvalReplay,
      invocation(['approval-1'])
    )
    await router.dispatcher.invoke(computeApplicationCommands.approvalReplayPending, invocation([]))
    const filter = { sessionId: 'session-1', status: ['done'] }
    await router.dispatcher.invoke(computeApplicationCommands.jobsList, invocation([filter]))
    await router.dispatcher.invoke(
      computeApplicationCommands.jobsPendingNotification,
      invocation(['session-1'])
    )
    await router.dispatcher.invoke(
      computeApplicationCommands.jobsMarkConsumed,
      invocation(['session-1', ['job-1']])
    )
    const analysisTransition = {
      sessionId: 'session-1',
      jobIds: ['job-1'],
      messageId: 'analysis-message-1',
      state: 'dispatched' as const
    }
    await router.dispatcher.invoke(
      computeApplicationCommands.jobsTransitionAnalysis,
      invocation([analysisTransition])
    )
    await router.dispatcher.invoke(
      computeApplicationCommands.enabledHostsGet,
      invocation(['session-1'])
    )
    const enabledHostsResult = await router.dispatcher.invoke(
      computeApplicationCommands.enabledHostsSet,
      invocation(['session-1', ['ssh:cluster']])
    )
    const hostEnabledResult = await router.dispatcher.invoke(
      computeApplicationCommands.hostEnabledSet,
      invocation(['session-1', 'ssh:cluster', true])
    )
    const hostSelectedResult = await router.dispatcher.invoke(
      computeApplicationCommands.hostSelectedSet,
      invocation(['session-1', 'ssh:cluster', true])
    )
    await router.dispatcher.invoke(
      computeApplicationCommands.bookmarksGet,
      invocation(['ssh:cluster'])
    )
    await router.dispatcher.invoke(
      computeApplicationCommands.bookmarksSet,
      invocation(['ssh:cluster', ['/work']])
    )

    expect(dependencies.compute.create).toHaveBeenCalledWith(createRequest)
    expect(dependencies.compute.createPassword).toHaveBeenCalledWith(passwordRequest)
    expect(dependencies.compute.resetPassword).toHaveBeenCalledWith(resetPasswordRequest)
    expect(dependencies.compute.changeAuthentication).toHaveBeenCalledWith(changeRequest)
    expect(createPasswordResult).toEqual({ ok: true, host })
    expect(dependencies.compute.passwordCapability).toHaveBeenCalledOnce()
    expect(dependencies.compute.delete).toHaveBeenCalledWith('ssh:cluster', {
      allowPasswordCredentialDeletion: true
    })
    expect(dependencies.compute.detailsSave).toHaveBeenCalledWith(
      'ssh:cluster',
      'new',
      'old',
      'user'
    )
    expect(dependencies.compute.scratchClear).toHaveBeenCalledWith('ssh:cluster')
    expect(dependencies.compute.download).toHaveBeenCalledWith(
      'ssh:cluster',
      '/work/result.csv',
      destination
    )
    expect(dependencies.compute.approvalRespond).toHaveBeenCalledWith('approval-1', 'once')
    expect(dependencies.compute.approvalReplay).toHaveBeenCalledWith('approval-1')
    expect(dependencies.compute.approvalReplayPending).toHaveBeenCalledOnce()
    expect(dependencies.compute.jobsList).toHaveBeenCalledWith(filter)
    expect(dependencies.compute.jobsMarkConsumed).toHaveBeenCalledWith('session-1', ['job-1'])
    expect(dependencies.compute.jobsTransitionAnalysis).toHaveBeenCalledWith(analysisTransition)
    expect(dependencies.enabledHosts.set).toHaveBeenCalledWith('session-1', ['ssh:cluster'])
    expect(enabledHostsResult).toEqual(session)
    expect(dependencies.enabledHosts.setHostEnabled).toHaveBeenCalledWith(
      'session-1',
      'ssh:cluster',
      true
    )
    expect(dependencies.enabledHosts.setHostSelected).toHaveBeenCalledWith(
      'session-1',
      'ssh:cluster',
      true
    )
    expect(hostEnabledResult).toEqual(session)
    expect(hostSelectedResult).toEqual(session)
    expect(dependencies.events.publish).toHaveBeenCalledWith('session:updated', {
      session,
      originClientId: 'main:enabled-compute-hosts'
    })
    expect(dependencies.bookmarks.set).toHaveBeenCalledWith('ssh:cluster', ['/work'])
  })

  it('normalizes the legacy conversation approval scope at the command boundary', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerComputeApplicationCommands(router.registrar, dependencies)

    await router.dispatcher.invoke(
      computeApplicationCommands.approvalRespond,
      invocation([{ id: 'approval-1', decision: 'conversation' }])
    )

    expect(dependencies.compute.approvalRespond).toHaveBeenCalledWith('approval-1', 'session')
  })

  it('serializes RemoteFsError details for both remote filesystem commands', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerComputeApplicationCommands(router.registrar, dependencies)
    const remoteFsError = {
      detail: 'remote path is missing',
      remoteKind: 'not_found' as const,
      retry_after_user_action: true
    }
    const failure = Object.assign(new Error('remote path is missing'), { remoteFsError })
    vi.mocked(dependencies.compute.listDir).mockRejectedValueOnce(failure)
    vi.mocked(dependencies.compute.download).mockRejectedValueOnce(failure)

    for (const operation of [
      () =>
        router.dispatcher.invoke(
          computeApplicationCommands.listDir,
          invocation(['ssh:cluster', '/missing'])
        ),
      () =>
        router.dispatcher.invoke(
          computeApplicationCommands.download,
          invocation(['ssh:cluster', '/missing', { kind: 'os-downloads' }])
        )
    ]) {
      const error = await operation().then(
        () => {
          throw new Error('Expected remote filesystem command to reject.')
        },
        (caught: unknown) => caught as Error
      )
      expect(error.message).toContain('remote path is missing')
      expect(decodeRemoteFsError(error.message)).toEqual(remoteFsError)
    }

    const plainFailure = new Error('plain failure')
    vi.mocked(dependencies.compute.listDir).mockRejectedValueOnce(plainFailure)
    await expect(
      router.dispatcher.invoke(
        computeApplicationCommands.listDir,
        invocation(['ssh:cluster', '/unavailable'])
      )
    ).rejects.toBe(plainFailure)
  })

  it('serializes a stable authentication code without raw SSH diagnostics', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerComputeApplicationCommands(router.registrar, dependencies)
    const remoteFsError = {
      detail: 'Authentication failed. Verify the username and password.',
      remoteKind: 'connection' as const,
      authenticationCode: 'authentication_failed' as const
    }
    vi.mocked(dependencies.compute.listDir).mockRejectedValueOnce(
      Object.assign(new Error(remoteFsError.detail), { remoteFsError })
    )

    const failure = await router.dispatcher
      .invoke(computeApplicationCommands.listDir, invocation(['ssh:cluster', '/work']))
      .then(
        () => {
          throw new Error('Expected authentication failure.')
        },
        (error: unknown) => error as Error
      )

    expect(decodeRemoteFsError(failure.message)).toEqual(remoteFsError)
    expect(failure.message).not.toContain('Permission denied')
  })

  it('rejects local-only commands from remote callers before invoking their owners', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerComputeApplicationCommands(router.registrar, dependencies)
    const callerContext = createWebCallerContext('remote-web', { location: 'remote' })

    await expect(
      router.dispatcher.invoke(
        computeApplicationCommands.jobsSetRemoteCleanup,
        invocation(
          [
            {
              jobId: 'job-1',
              providerId: 'ssh:cluster',
              projectId: 'project-1',
              sessionId: 'session-1',
              disposition: 'cleaned'
            }
          ],
          callerContext
        )
      )
    ).rejects.toThrow('Channel only available from the local app: compute:jobs:set-remote-cleanup')
    expect(dependencies.compute.jobsSetRemoteCleanup).not.toHaveBeenCalled()

    await expect(
      router.dispatcher.invoke(
        computeApplicationCommands.download,
        invocation(['ssh:cluster', '/work/result.csv', { kind: 'os-downloads' }], callerContext)
      )
    ).rejects.toThrow('Channel only available from the local app: compute:download')
    await expect(
      router.dispatcher.invoke(
        computeApplicationCommands.revealInFolder,
        invocation(['/tmp/result.csv'], callerContext)
      )
    ).rejects.toThrow('Channel only available from the local app: compute:reveal-in-folder')
    await expect(
      router.dispatcher.invoke(
        computeApplicationCommands.passwordCapability,
        invocation([], callerContext)
      )
    ).rejects.toThrow('Channel only available from the local app: compute:password-capability')
    await expect(
      router.dispatcher.invoke(
        computeApplicationCommands.createPassword,
        invocation(
          [
            {
              sshAlias: 'cluster',
              authenticationMode: 'password',
              username: 'researcher',
              port: 22,
              password: 'secret',
              operationId: 'operation-1'
            }
          ],
          callerContext
        )
      )
    ).rejects.toThrow('Channel only available from the local app: compute:create-password')
    await expect(
      router.dispatcher.invoke(
        computeApplicationCommands.resetPassword,
        invocation(
          [
            {
              providerId: 'ssh:cluster',
              password: 'secret',
              operationId: 'reset-operation-1',
              expectedAuthenticationRevision: 1
            }
          ],
          callerContext
        )
      )
    ).rejects.toThrow('Channel only available from the local app: compute:reset-password')
    await expect(
      router.dispatcher.invoke(
        computeApplicationCommands.changeAuthentication,
        invocation(
          [
            {
              providerId: 'ssh:cluster',
              expectedRevision: 1,
              operationId: 'operation-change-1',
              authenticationMode: 'ssh_config',
              username: 'researcher',
              port: 22
            }
          ],
          callerContext
        )
      )
    ).rejects.toThrow('Channel only available from the local app: compute:change-authentication')
    await expect(
      router.dispatcher.invoke(
        computeApplicationCommands.delete,
        invocation([{ providerId: 'ssh:cluster' }], callerContext)
      )
    ).resolves.toBeUndefined()
    await expect(
      router.dispatcher.invoke(
        computeApplicationCommands.deletionStatus,
        invocation([{ providerId: 'ssh:cluster' }], callerContext)
      )
    ).resolves.toEqual({ blockedByJobs: false })

    expect(dependencies.compute.download).not.toHaveBeenCalled()
    expect(dependencies.compute.revealInFolder).not.toHaveBeenCalled()
    expect(dependencies.compute.createPassword).not.toHaveBeenCalled()
    expect(dependencies.compute.resetPassword).not.toHaveBeenCalled()
    expect(dependencies.compute.changeAuthentication).not.toHaveBeenCalled()
    expect(dependencies.compute.passwordCapability).not.toHaveBeenCalled()
    expect(dependencies.compute.delete).toHaveBeenCalledWith('ssh:cluster', {
      allowPasswordCredentialDeletion: false
    })
    expect(dependencies.compute.deletionStatus).toHaveBeenCalledOnce()
  })

  it('accepts Compute approval responses only from current human-originated callers', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerComputeApplicationCommands(router.registrar, dependencies)
    const args = [{ id: 'approval-1', decision: 'once' }] as const
    const allowedCallers = [
      createElectronCallerContext(7),
      createWebCallerContext('local-web'),
      createWebCallerContext('remote-web', { location: 'remote' })
    ]

    for (const callerContext of allowedCallers) {
      await expect(
        router.dispatcher.invoke(
          computeApplicationCommands.approvalRespond,
          invocation(args, callerContext)
        )
      ).resolves.toBeUndefined()
      await expect(
        router.dispatcher.invoke(
          computeApplicationCommands.approvalReplay,
          invocation(['approval-1'], callerContext)
        )
      ).resolves.toBeNull()
      await expect(
        router.dispatcher.invoke(
          computeApplicationCommands.approvalReplayPending,
          invocation([], callerContext)
        )
      ).resolves.toBeUndefined()
    }

    const deniedCallers = [
      createTaskCallerContext(),
      createCallerContext({
        clientId: 'agent-session',
        lifecycleClientId: 'web:agent-session',
        leaseId: 'agent-session',
        surface: 'web',
        location: 'local',
        principalKind: 'agent-session',
        actionOrigin: 'agent-session'
      }),
      createWebCallerContext('agent-origin', { actionOrigin: 'agent-session' })
    ]
    for (const callerContext of deniedCallers) {
      await expect(
        router.dispatcher.invoke(
          computeApplicationCommands.approvalRespond,
          invocation(args, callerContext)
        )
      ).rejects.toThrow('Only a current human caller can respond to compute approval requests.')
      await expect(
        router.dispatcher.invoke(
          computeApplicationCommands.approvalReplay,
          invocation(['approval-1'], callerContext)
        )
      ).rejects.toThrow('Only a current human caller can reopen compute approval requests.')
      await expect(
        router.dispatcher.invoke(
          computeApplicationCommands.approvalReplayPending,
          invocation([], callerContext)
        )
      ).rejects.toThrow('Only a current human caller can reopen compute approval requests.')
    }
    await expect(
      router.dispatcher.invoke(
        computeApplicationCommands.approvalRespond,
        invocation(args, createWebCallerContext('stale', { isAuthorizationCurrent: () => false }))
      )
    ).rejects.toThrow('Caller authorization is no longer current.')

    expect(dependencies.compute.approvalRespond).toHaveBeenCalledTimes(allowedCallers.length)
    expect(dependencies.compute.approvalReplay).toHaveBeenCalledTimes(allowedCallers.length)
    expect(dependencies.compute.approvalReplayPending).toHaveBeenCalledTimes(allowedCallers.length)
  })
})
