import { describe, expect, it, vi } from 'vitest'

import type { RemoteAccessSnapshot } from '../shared/remote-access'
import { RENDERER_CONTRACT_GROUPS } from '../shared/renderer-contract-catalog'
import type { UpdateStatus } from '../shared/update'
import {
  createApplicationCommandRouter,
  type ApplicationCallerLease,
  type ApplicationCommand,
  type ApplicationInvocation
} from './application-command-router'
import {
  createElectronCallerContext,
  createWebCallerContext,
  type CallerContext
} from './caller-context'
import {
  hostApplicationCommandGroups,
  hostApplicationCommands,
  registerHostApplicationCommands,
  type HostApplicationCommandDependencies
} from './host-application-commands'

const HOST_CAPABILITIES = [
  'cli',
  'github',
  'local-fs',
  'logs',
  'notifications',
  'remote-access',
  'reviewer',
  'storage',
  'update'
] as const

const remoteSnapshot: RemoteAccessSnapshot = {
  canManage: true,
  canManagePairing: true,
  mode: 'off',
  enabled: false,
  lifecycle: 'disabled',
  remoteIt: { installed: false, loggedIn: false, registered: false },
  pendingRequests: [],
  trustedBrowsers: [
    {
      id: 'trusted-browser',
      browser: 'Safari',
      platform: 'macOS',
      createdAt: 1,
      lastSeenAt: 2,
      expiresAt: 3
    }
  ]
}

const updateStatus: UpdateStatus = { state: 'idle', current: '1.0.0' }

const createDependencies = (): HostApplicationCommandDependencies => ({
  cli: {
    getStatus: vi.fn(async () => ({
      installed: false,
      target: '/bin/open-science',
      onPath: false
    })),
    install: vi.fn(async () => ({ installed: true, target: '/bin/open-science', onPath: true })),
    uninstall: vi.fn(async () => ({ installed: false, target: '/bin/open-science', onPath: true }))
  },
  github: { getStars: vi.fn(async () => 42) },
  localFs: {
    getRoots: vi.fn(() => ({ home: '/home/scientist', machineName: 'Lab' })),
    grantRoot: vi.fn(async () => []),
    listDir: vi.fn(async (path: string) => ({ entries: [], truncated: false, resolvedPath: path })),
    listDrives: vi.fn(async () => []),
    listGrantedRoots: vi.fn(async () => []),
    openPath: vi.fn(async () => ''),
    readPreview: vi.fn(async () => ({
      content: 'result',
      encoding: 'utf8' as const,
      size: 6,
      truncated: false
    })),
    removeGrantedRoot: vi.fn(async () => []),
    revealInFolder: vi.fn(() => undefined),
    setGrantedRootAccess: vi.fn(async () => [])
  },
  logs: {
    getStatus: vi.fn(async () => ({
      configured: true,
      path: '/logs/main.log',
      existing: true,
      lastWriteSucceeded: true,
      lastFailureCategory: null
    })),
    openFile: vi.fn(async () => ({ opened: true })),
    revealInFolder: vi.fn(async () => ({ revealed: true }))
  },
  notifications: {
    getSnapshot: vi.fn(async () => ({
      revision: 1,
      unreadCount: 0,
      latestSequence: 0,
      items: []
    })),
    markAllRead: vi.fn(async () => undefined),
    markRead: vi.fn(async () => undefined),
    markSessionCompletionsRead: vi.fn(async () => undefined),
    peekPendingOpenSession: vi.fn(() => ({ sessionId: 'session-1', token: 7 })),
    takePendingOpenSession: vi.fn(() => ({ sessionId: 'session-1', token: 7 }))
  },
  remoteAccess: {
    snapshot: vi.fn(() => remoteSnapshot),
    detect: vi.fn(async () => remoteSnapshot),
    probe: vi.fn(async () => remoteSnapshot),
    setMode: vi.fn(async () => remoteSnapshot),
    disable: vi.fn(async () => remoteSnapshot),
    approve: vi.fn(async () => remoteSnapshot),
    reject: vi.fn(() => remoteSnapshot),
    revoke: vi.fn(async () => remoteSnapshot)
  } as unknown as HostApplicationCommandDependencies['remoteAccess'],
  reviewer: {
    run: vi.fn(async () => ({ started: true })),
    getForSession: vi.fn(async () => []),
    abort: vi.fn(() => undefined),
    abortFixLoop: vi.fn(() => undefined)
  },
  storage: {
    acceptMissingDataRoot: vi.fn(async () => undefined),
    acknowledgeDataRootHandoffFlush: vi.fn(() => undefined),
    getStatus: vi.fn(async () => ({
      dataRoot: '/data',
      isDefault: true,
      defaultDataRoot: '/data',
      defaultParent: '/',
      dataRootMissing: false,
      legacyDataMovePrompt: false,
      cleanupPending: false
    })),
    getInfo: vi.fn(async () => ({
      dataRoot: '/data',
      isDefault: true,
      defaultDataRoot: '/data',
      defaultParent: '/',
      dataRootMissing: false,
      legacyDataMovePrompt: false,
      cleanupPending: false,
      canAutoSelectDataDrive: false,
      usage: { categories: [], totalBytes: 0 },
      availableBytes: 100
    })),
    revealAppStorage: vi.fn(async () => ({ revealed: true })),
    detectActive: vi.fn(() => []),
    pickDirectory: vi.fn(async () => '/data-parent'),
    validateDataRoot: vi.fn(async () => ({ ok: true as const })),
    inspectDataRoot: vi.fn(async () => ({
      kind: 'move' as const,
      dataRoot: '/target/OpenScience'
    })),
    migrate: vi.fn(async () => ({ ok: true as const, cleanupPending: false })),
    setDataRootAndRelaunch: vi.fn(async () => ({ ok: true as const })),
    cancelMigrate: vi.fn(() => undefined),
    commitAndRelaunch: vi.fn(async () => ({ ok: true as const, cleanupPending: false })),
    discardMigratedCopy: vi.fn(async () => ({ ok: true as const })),
    dismissLegacyMovePrompt: vi.fn(async () => undefined)
  },
  update: {
    getAppInfo: vi.fn(() => ({ name: 'Open Science', version: '1.0.0', copyright: 'Aipoch' })),
    getStatus: vi.fn(() => updateStatus),
    check: vi.fn(async () => updateStatus),
    download: vi.fn(async () => updateStatus),
    cancel: vi.fn(async () => updateStatus),
    apply: vi.fn(async () => updateStatus)
  }
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

const commandByName = (name: string): ApplicationCommand<string, readonly unknown[], unknown> => {
  for (const { commands } of hostApplicationCommandGroups) {
    const command = (
      commands as readonly ApplicationCommand<string, readonly unknown[], unknown>[]
    ).find((candidate) => candidate.name === name)
    if (command) return command
  }
  throw new Error(`Missing host command: ${name}`)
}

describe('Host application commands', () => {
  it('defines the exact 56 Electron request channels in their existing capability groups', () => {
    const expected = RENDERER_CONTRACT_GROUPS.filter(({ capability }) =>
      HOST_CAPABILITIES.includes(capability as (typeof HOST_CAPABILITIES)[number])
    ).map(({ capability, contracts }) => {
      const rendererChannels = contracts
        .filter(
          ({ kind, surfaceInstallation }) =>
            kind === 'method' &&
            (surfaceInstallation.localWeb === 'web-rpc' ||
              (capability === 'remote-access' && surfaceInstallation.electron === 'preload'))
        )
        .map(({ channel }) => channel)
        .filter((channel): channel is string => channel !== null)
      return {
        capability,
        channels:
          capability === 'reviewer' ? ['reviewer:abort', ...rendererChannels] : rendererChannels
      }
    })

    expect(expected.flatMap(({ channels }) => channels)).toHaveLength(56)
    expect(
      hostApplicationCommandGroups.map(({ name, commands }) => ({
        capability: name,
        channels: commands.map(({ name: commandName }) => commandName)
      }))
    ).toEqual(expected)
  })

  it('installs and uninstalls every host group atomically', () => {
    const router = createApplicationCommandRouter()
    const installation = registerHostApplicationCommands(
      router.registrar,
      {} as HostApplicationCommandDependencies
    )

    expect(router.dispatcher.commandNames()).toHaveLength(56)
    installation.uninstall()
    expect(router.dispatcher.commandNames()).toEqual([])
  })

  it('delegates every canonical argument tuple to the existing capability owner', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerHostApplicationCommands(router.registrar, dependencies)
    const previewRequest = { path: '/data/result.txt', encoding: 'utf8' as const }
    const reviewRun = {
      sessionId: 'session-1',
      turnMessageId: 'message-1',
      projectId: 'project-1',
      origin: 'manual' as const
    }
    const reviewSession = { projectId: 'project-1', appSessionId: 'session-1' }
    const parent = { parent: '/target' }
    const root = { parent: '/target', markOnboarding: true }
    const flushResponse = { requestId: 'flush-1', status: 'completed' as const }
    const markReadRequest = { ids: ['message-1'] }
    const markAllReadRequest = { throughSequence: 7 }
    const markSessionCompletionsReadRequest = { sessionIds: ['session-1'] }

    await router.dispatcher.invoke(hostApplicationCommands.cli.getStatus, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.cli.install, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.cli.uninstall, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.github.getStars, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.localFs.getRoots, invocation([]))
    await router.dispatcher.invoke(
      hostApplicationCommands.localFs.grantRoot,
      invocation([{ path: '/data', access: 'ro' }])
    )
    await router.dispatcher.invoke(hostApplicationCommands.localFs.listDir, invocation(['/data']))
    await router.dispatcher.invoke(hostApplicationCommands.localFs.listDrives, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.localFs.listGrantedRoots, invocation([]))
    await router.dispatcher.invoke(
      hostApplicationCommands.localFs.openPath,
      invocation(['/data/a'])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.localFs.readPreview,
      invocation([previewRequest])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.localFs.removeGrantedRoot,
      invocation([{ id: 'root-1' }])
    )
    await router.dispatcher.invoke(hostApplicationCommands.localFs.reveal, invocation(['/data/a']))
    await router.dispatcher.invoke(
      hostApplicationCommands.localFs.setGrantedRootAccess,
      invocation([{ id: 'root-1', access: 'rw' }])
    )
    await router.dispatcher.invoke(hostApplicationCommands.logs.getStatus, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.logs.openFile, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.logs.revealInFolder, invocation([]))
    await router.dispatcher.invoke(
      hostApplicationCommands.notifications.getSnapshot,
      invocation([])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.notifications.markAllRead,
      invocation([markAllReadRequest])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.notifications.markRead,
      invocation([markReadRequest])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.notifications.markSessionCompletionsRead,
      invocation([markSessionCompletionsReadRequest])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.notifications.peekPendingOpenSession,
      invocation([])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.notifications.takePendingOpenSession,
      invocation([7])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.remoteAccess.approve,
      invocation([{ requestId: 'pair-1', decision: 'once' }])
    )
    await router.dispatcher.invoke(hostApplicationCommands.remoteAccess.detect, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.remoteAccess.probe, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.remoteAccess.disable, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.remoteAccess.getSnapshot, invocation([]))
    await router.dispatcher.invoke(
      hostApplicationCommands.remoteAccess.reject,
      invocation([{ requestId: 'pair-2' }])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.remoteAccess.revokeBrowser,
      invocation([{ browserId: 'browser-1' }])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.remoteAccess.setMode,
      invocation([{ mode: 'remoteit' }])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.reviewer.abort,
      invocation([reviewSession])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.reviewer.abortFixLoop,
      invocation([reviewSession])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.reviewer.getForSession,
      invocation([reviewSession])
    )
    await router.dispatcher.invoke(hostApplicationCommands.reviewer.run, invocation([reviewRun]))
    await router.dispatcher.invoke(
      hostApplicationCommands.storage.acceptMissingDataRoot,
      invocation([])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.storage.acknowledgeDataRootHandoffFlush,
      invocation([flushResponse])
    )
    await router.dispatcher.invoke(hostApplicationCommands.storage.cancelMigrate, invocation([]))
    await router.dispatcher.invoke(
      hostApplicationCommands.storage.commitAndRelaunch,
      invocation([parent])
    )
    await router.dispatcher.invoke(hostApplicationCommands.storage.detectActive, invocation([]))
    await router.dispatcher.invoke(
      hostApplicationCommands.storage.discardMigratedCopy,
      invocation([parent])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.storage.dismissLegacyMovePrompt,
      invocation([])
    )
    await router.dispatcher.invoke(hostApplicationCommands.storage.getStatus, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.storage.getInfo, invocation([]))
    await router.dispatcher.invoke(
      hostApplicationCommands.storage.inspectDataRoot,
      invocation([parent])
    )
    await router.dispatcher.invoke(hostApplicationCommands.storage.migrate, invocation([parent]))
    await router.dispatcher.invoke(hostApplicationCommands.storage.pickDirectory, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.storage.revealAppStorage, invocation([]))
    await router.dispatcher.invoke(
      hostApplicationCommands.storage.setDataRootAndRelaunch,
      invocation([root])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.storage.validateDataRoot,
      invocation([parent])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.update.apply,
      invocation([{ relaunch: false }])
    )
    await router.dispatcher.invoke(hostApplicationCommands.update.cancel, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.update.check, invocation([]))
    await router.dispatcher.invoke(
      hostApplicationCommands.update.download,
      invocation([{ nonInteractive: true }])
    )
    await router.dispatcher.invoke(hostApplicationCommands.update.getAppInfo, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.update.getStatus, invocation([]))

    expect(dependencies.localFs.listDir).toHaveBeenCalledWith('/data')
    expect(dependencies.localFs.readPreview).toHaveBeenCalledWith(previewRequest)
    expect(dependencies.notifications.takePendingOpenSession).toHaveBeenCalledWith(7)
    expect(dependencies.notifications.markAllRead).toHaveBeenCalledWith(markAllReadRequest)
    expect(dependencies.notifications.markRead).toHaveBeenCalledWith(markReadRequest)
    expect(dependencies.notifications.markSessionCompletionsRead).toHaveBeenCalledWith(
      markSessionCompletionsReadRequest
    )
    expect(dependencies.remoteAccess.approve).toHaveBeenCalledWith(
      { requestId: 'pair-1', decision: 'once' },
      true,
      true
    )
    expect(dependencies.remoteAccess.detect).toHaveBeenCalledOnce()
    expect(dependencies.remoteAccess.probe).toHaveBeenCalledOnce()
    expect(dependencies.remoteAccess.reject).toHaveBeenCalledWith('pair-2', true, true)
    expect(dependencies.remoteAccess.revoke).toHaveBeenCalledWith('browser-1', true, true)
    expect(dependencies.remoteAccess.setMode).toHaveBeenCalledWith('remoteit')
    expect(dependencies.reviewer.run).toHaveBeenCalledWith(reviewRun)
    expect(dependencies.reviewer.getForSession).toHaveBeenCalledWith(reviewSession)
    expect(dependencies.reviewer.abort).toHaveBeenCalledWith(reviewSession)
    expect(dependencies.storage.acknowledgeDataRootHandoffFlush).toHaveBeenCalledWith(
      flushResponse,
      'electron:7'
    )
    expect(dependencies.storage.commitAndRelaunch).toHaveBeenCalledWith(parent, {
      surface: 'electron-renderer'
    })
    expect(dependencies.storage.setDataRootAndRelaunch).toHaveBeenCalledWith(root, {
      surface: 'electron-renderer'
    })
    expect(dependencies.update.apply).toHaveBeenCalledWith({ relaunch: false })
    expect(dependencies.update.download).toHaveBeenCalledWith({ nonInteractive: true })

    const ownerMethods = Object.values(dependencies).flatMap((owner) => Object.values(owner))
    expect(
      ownerMethods.filter(vi.isMockFunction).every((method) => method.mock.calls.length === 1)
    ).toBe(true)
  })

  it('routes local Web data-root handoffs to the post-teardown renderer handshake', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerHostApplicationCommands(router.registrar, dependencies)
    const caller = createWebCallerContext('local-web')
    const parent = { parent: '/target' }
    const root = { ...parent, markOnboarding: true }

    await router.dispatcher.invoke(
      hostApplicationCommands.storage.migrate,
      invocation([parent], caller)
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.storage.commitAndRelaunch,
      invocation([parent], caller)
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.storage.setDataRootAndRelaunch,
      invocation([root], caller)
    )
    const flushResponse = { requestId: 'web-flush-1', status: 'completed' as const }
    await router.dispatcher.invoke(
      hostApplicationCommands.storage.acknowledgeDataRootHandoffFlush,
      invocation([flushResponse], caller)
    )

    const target = { surface: 'web-renderer', lifecycleClientId: 'web:local-web' }
    expect(dependencies.storage.migrate).toHaveBeenCalledWith(parent, target)
    expect(dependencies.storage.commitAndRelaunch).toHaveBeenCalledWith(parent, target)
    expect(dependencies.storage.setDataRootAndRelaunch).toHaveBeenCalledWith(root, target)
    expect(dependencies.storage.acknowledgeDataRootHandoffFlush).toHaveBeenCalledWith(
      flushResponse,
      'web:local-web'
    )
  })

  it('rejects the exact local-only host inventory before entering an owner', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerHostApplicationCommands(router.registrar, dependencies)
    const remoteCaller = createWebCallerContext('remote-browser', { location: 'remote' })
    const previewRequest = { path: '/data/result.txt', encoding: 'utf8' as const }
    const parent = { parent: '/target' }
    const argsByChannel: Readonly<Record<string, readonly unknown[]>> = {
      'storage:accept-missing-data-root': [],
      'storage:ack-data-root-handoff-flush': [{ requestId: 'flush-1', status: 'completed' }],
      'local-fs:grant-root': [{ path: '/data', access: 'ro' }],
      'local-fs:granted-roots:remove': [{ id: 'root-1' }],
      'local-fs:granted-roots:set-access': [{ id: 'root-1', access: 'rw' }],
      'local-fs:list-dir': ['/data'],
      'local-fs:open-path': ['/data/result.txt'],
      'local-fs:read-preview': [previewRequest],
      'local-fs:reveal': ['/data/result.txt'],
      'storage:commit-and-relaunch': [parent],
      'storage:discard-migrated-copy': [parent],
      'storage:inspect-data-root': [parent],
      'storage:migrate': [parent],
      'storage:set-data-root-and-relaunch': [{ ...parent, markOnboarding: true }],
      'storage:validate-data-root': [parent]
    }
    const localOnlyChannels = RENDERER_CONTRACT_GROUPS.filter(({ capability }) =>
      HOST_CAPABILITIES.includes(capability as (typeof HOST_CAPABILITIES)[number])
    ).flatMap(({ contracts }) =>
      contracts
        .filter(
          ({ surfaceInstallation }) =>
            surfaceInstallation.localWeb === 'web-rpc' &&
            surfaceInstallation.remoteWeb === 'rejecting-stub'
        )
        .map(({ channel }) => channel)
        .filter((channel): channel is string => channel !== null)
    )

    expect(localOnlyChannels).toHaveLength(30)
    for (const channel of localOnlyChannels) {
      await expect(
        router.dispatcher.invoke(
          commandByName(channel),
          invocation(argsByChannel[channel] ?? [], remoteCaller)
        )
      ).rejects.toThrow(`Channel only available from the local app: ${channel}`)
    }

    const ownerMethods = Object.values(dependencies).flatMap((owner) => Object.values(owner))
    expect(
      ownerMethods.filter(vi.isMockFunction).every((method) => method.mock.calls.length === 0)
    ).toBe(true)
  })

  it('rejects every logs command from a remote Web caller before entering the owner', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerHostApplicationCommands(router.registrar, dependencies)
    const remoteCaller = createWebCallerContext('remote-browser', { location: 'remote' })
    const channels =
      RENDERER_CONTRACT_GROUPS.find(({ capability }) => capability === 'logs')?.contracts.flatMap(
        ({ channel }) => (channel === null ? [] : [channel])
      ) ?? []

    expect(channels.length).toBeGreaterThan(0)
    for (const channel of channels) {
      await expect(
        router.dispatcher.invoke(commandByName(channel), invocation([], remoteCaller))
      ).rejects.toThrow(`Channel only available from the local app: ${channel}`)
    }

    expect(dependencies.logs.getStatus).not.toHaveBeenCalled()
    expect(dependencies.logs.openFile).not.toHaveBeenCalled()
    expect(dependencies.logs.revealInFolder).not.toHaveBeenCalled()
  })

  it('keeps the read-only Remote Access probe available only to local callers', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerHostApplicationCommands(router.registrar, dependencies)
    const localCaller = createWebCallerContext('local-browser')
    const remoteCaller = createWebCallerContext('remote-browser', { location: 'remote' })

    await expect(
      router.dispatcher.invoke(
        hostApplicationCommands.remoteAccess.probe,
        invocation([], localCaller)
      )
    ).resolves.toBe(remoteSnapshot)
    expect(remoteSnapshot.trustedBrowsers[0]).toMatchObject({ expiresAt: 3 })
    await expect(
      router.dispatcher.invoke(
        hostApplicationCommands.remoteAccess.probe,
        invocation([], remoteCaller)
      )
    ).rejects.toThrow('Channel only available from the local app: remote-access:probe')
    expect(dependencies.remoteAccess.probe).toHaveBeenCalledOnce()
  })

  it('preserves the five-state Remote Access authority and freshness matrix', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerHostApplicationCommands(router.registrar, dependencies)
    const desktop = createElectronCallerContext(7)
    const localWeb = createWebCallerContext('local-web')
    const ordinaryRemote = createWebCallerContext('ordinary-remote', { location: 'remote' })
    const currentManager = createWebCallerContext('pairing-manager', {
      location: 'remote',
      authorities: ['manage-remote-pairing']
    })
    const staleManager = createWebCallerContext('stale-manager', {
      location: 'remote',
      authorities: ['manage-remote-pairing'],
      isAuthorizationCurrent: () => false
    })

    for (const caller of [desktop, localWeb, ordinaryRemote, currentManager]) {
      await router.dispatcher.invoke(
        hostApplicationCommands.remoteAccess.getSnapshot,
        invocation([], caller)
      )
    }
    await expect(
      router.dispatcher.invoke(
        hostApplicationCommands.remoteAccess.getSnapshot,
        invocation([], staleManager)
      )
    ).rejects.toThrow('Caller authorization is no longer current.')

    expect(dependencies.remoteAccess.snapshot).toHaveBeenNthCalledWith(1, true, true)
    expect(dependencies.remoteAccess.snapshot).toHaveBeenNthCalledWith(2, false, false)
    expect(dependencies.remoteAccess.snapshot).toHaveBeenNthCalledWith(3, false, false)
    expect(dependencies.remoteAccess.snapshot).toHaveBeenNthCalledWith(4, false, true)

    const approval = { requestId: 'pair-1', decision: 'once' as const }
    await expect(
      router.dispatcher.invoke(
        hostApplicationCommands.remoteAccess.approve,
        invocation([approval], ordinaryRemote)
      )
    ).rejects.toThrow(
      'Pairing can only be managed from the Open Science desktop app or an approved browser.'
    )
    await expect(
      router.dispatcher.invoke(
        hostApplicationCommands.remoteAccess.approve,
        invocation([approval], currentManager)
      )
    ).resolves.toBe(remoteSnapshot)
    expect(dependencies.remoteAccess.approve).toHaveBeenCalledWith(approval, false, true)

    await expect(
      router.dispatcher.invoke(
        hostApplicationCommands.remoteAccess.detect,
        invocation([], currentManager)
      )
    ).rejects.toThrow('This action must be approved from the Open Science desktop app.')
    await expect(
      router.dispatcher.invoke(
        hostApplicationCommands.remoteAccess.probe,
        invocation([], currentManager)
      )
    ).rejects.toThrow('Channel only available from the local app: remote-access:probe')
    expect(dependencies.remoteAccess.detect).not.toHaveBeenCalled()
    expect(dependencies.remoteAccess.probe).not.toHaveBeenCalled()
  })

  it('rejects malformed Remote Access arguments before entering an owner', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerHostApplicationCommands(router.registrar, dependencies)
    const cases: Array<readonly [string, readonly unknown[]]> = [
      ['remote-access:approve', [undefined]],
      ['remote-access:detect', [{}]],
      ['remote-access:probe', [{}]],
      ['remote-access:disable', [{}]],
      ['remote-access:get-snapshot', [{}]],
      ['remote-access:reject', [undefined]],
      ['remote-access:revoke-browser', [undefined]],
      ['remote-access:set-mode', [{ mode: 'invalid' }]]
    ]

    for (const [channel, args] of cases) {
      await expect(
        router.dispatcher.invoke(commandByName(channel), invocation(args))
      ).rejects.toMatchObject({ code: 'invalid-command-arguments' })
    }

    expect(dependencies.remoteAccess.approve).not.toHaveBeenCalled()
    expect(dependencies.remoteAccess.detect).not.toHaveBeenCalled()
    expect(dependencies.remoteAccess.probe).not.toHaveBeenCalled()
    expect(dependencies.remoteAccess.disable).not.toHaveBeenCalled()
    expect(dependencies.remoteAccess.snapshot).not.toHaveBeenCalled()
    expect(dependencies.remoteAccess.reject).not.toHaveBeenCalled()
    expect(dependencies.remoteAccess.revoke).not.toHaveBeenCalled()
    expect(dependencies.remoteAccess.setMode).not.toHaveBeenCalled()
  })

  it('keeps pending-notification token validation ahead of owner mutation', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerHostApplicationCommands(router.registrar, dependencies)

    for (const invalidToken of ['7', 0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(
        router.dispatcher.invoke(
          hostApplicationCommands.notifications.takePendingOpenSession,
          invocation([invalidToken])
        )
      ).resolves.toBeNull()
    }
    expect(dependencies.notifications.takePendingOpenSession).not.toHaveBeenCalled()

    await expect(
      router.dispatcher.invoke(
        hostApplicationCommands.notifications.takePendingOpenSession,
        invocation([7])
      )
    ).resolves.toEqual({ sessionId: 'session-1', token: 7 })
    expect(dependencies.notifications.takePendingOpenSession).toHaveBeenCalledWith(7)
  })

  it('rejects malformed message read requests ahead of owner mutation', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerHostApplicationCommands(router.registrar, dependencies)

    for (const invalidRequest of [undefined, null, {}, { ids: 'message-1' }, { ids: [1] }]) {
      await expect(
        router.dispatcher.invoke(
          commandByName('notifications:mark-read'),
          invocation([invalidRequest])
        )
      ).rejects.toThrow('Invalid notifications:mark-read request.')
    }
    for (const invalidRequest of [
      undefined,
      null,
      {},
      { throughSequence: '7' },
      { throughSequence: -1 }
    ]) {
      await expect(
        router.dispatcher.invoke(
          commandByName('notifications:mark-all-read'),
          invocation([invalidRequest])
        )
      ).rejects.toThrow('Invalid notifications:mark-all-read request.')
    }
    for (const invalidRequest of [
      undefined,
      null,
      {},
      { sessionIds: 'session-1' },
      { sessionIds: [1] }
    ]) {
      await expect(
        router.dispatcher.invoke(
          commandByName('notifications:mark-session-completions-read'),
          invocation([invalidRequest])
        )
      ).rejects.toThrow('Invalid notifications:mark-session-completions-read request.')
    }

    expect(dependencies.notifications.markRead).not.toHaveBeenCalled()
    expect(dependencies.notifications.markAllRead).not.toHaveBeenCalled()
    expect(dependencies.notifications.markSessionCompletionsRead).not.toHaveBeenCalled()
  })
})
