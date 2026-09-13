import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const routerFactoryControl = vi.hoisted(() => ({
  actual: undefined as ((onDiagnostic?: unknown) => unknown) | undefined,
  replacement: undefined as ((onDiagnostic?: unknown) => unknown) | undefined
}))

vi.mock('./application-command-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./application-command-router')>()
  routerFactoryControl.actual = actual.createApplicationCommandRouter as unknown as (
    onDiagnostic?: unknown
  ) => unknown
  return {
    ...actual,
    createApplicationCommandRouter: (
      onDiagnostic?: Parameters<typeof actual.createApplicationCommandRouter>[0]
    ) =>
      routerFactoryControl.replacement?.(onDiagnostic) ??
      actual.createApplicationCommandRouter(onDiagnostic)
  }
})

import { RENDERER_CONTRACT_CATALOG } from '../shared/renderer-contract-catalog'
import type { Project } from '../shared/projects'
import {
  createApplicationCommandComposition,
  type ApplicationCommandCompositionDependencies
} from './application-command-composition'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRouter,
  type ApplicationCommandRegistrationScope,
  type ApplicationInvocation
} from './application-command-router'
import { createCallerContext } from './caller-context'
import { ApplicationCallerLeaseRegistry } from './caller-lifecycle'
import { createManagedPreviewOwnerRegistry } from './managed-preview-ipc'
import { ManagedPreviewResources } from './managed-preview-resources'
import { LocalFsService } from './local-fs/service'
import type { ManagedPreviewResource, ManagedPreviewRangeResult } from '../shared/preview-resources'

const EMPTY_OWNER = Object.freeze({})

it('exposes bootstrap only to local Task callers without widening renderer management', async () => {
  const bootstrap = vi.fn(async () => ({ ok: true }))
  const composition = createApplicationCommandComposition({
    ...dependencies(),
    settingsCore: {
      service: { bootstrap },
      emitInstallEvent: vi.fn(),
      snapshotCommits: { projectAfter: (pending: Promise<unknown>) => pending }
    } as never
  })
  expect(composition.localWeb.commandNames()).not.toContain('settings:bootstrap')
  expect(composition.remoteWeb.commandNames()).not.toContain('settings:bootstrap')
  await expect(
    composition.task.invoke('settings:bootstrap', {
      ...invocation('remote'),
      args: [{ action: 'runtime' }]
    })
  ).resolves.toEqual({ ok: false, code: 'invalid_request' })
  expect(bootstrap).not.toHaveBeenCalled()
  await expect(
    composition.task.invoke('settings:bootstrap', {
      ...invocation(),
      args: [{ action: 'runtime' }]
    })
  ).resolves.toEqual({ ok: true })
  expect(bootstrap).toHaveBeenCalledOnce()
  composition.dispose()
})
const unexpectedCommand = defineApplicationCommand<'test:unexpected', readonly [], void>(
  'test:unexpected'
)
const unexpectedGroup = defineApplicationCommandGroup('test-unexpected', [unexpectedCommand])
const project = (id: string): Project => ({
  id,
  name: 'Project',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1
})

const dependencies = (): ApplicationCommandCompositionDependencies =>
  ({
    acp: EMPTY_OWNER,
    notebook: EMPTY_OWNER,
    notebookEnvironment: EMPTY_OWNER,
    notebookRuntime: EMPTY_OWNER,
    settingsCore: EMPTY_OWNER,
    settingsIntegration: EMPTY_OWNER,
    settingsRuntime: EMPTY_OWNER,
    compute: EMPTY_OWNER,
    permissionGrants: EMPTY_OWNER,
    tags: EMPTY_OWNER,
    specialist: {
      dispose: vi.fn()
    } as unknown as ApplicationCommandCompositionDependencies['specialist'],
    memory: EMPTY_OWNER,
    literature: EMPTY_OWNER,
    dataContent: EMPTY_OWNER,
    host: EMPTY_OWNER
  }) as ApplicationCommandCompositionDependencies

const expectedLocalWebCommands = (): string[] =>
  RENDERER_CONTRACT_CATALOG.flatMap(({ channel, kind, surfaceInstallation }) =>
    channel !== null && kind === 'method' && surfaceInstallation.localWeb === 'web-rpc'
      ? [channel]
      : []
  ).sort()

const expectedRemoteCommands = (): string[] =>
  RENDERER_CONTRACT_CATALOG.flatMap(({ channel, kind, surfaceInstallation }) =>
    channel !== null && kind === 'method' && surfaceInstallation.remoteWeb === 'web-rpc'
      ? [channel]
      : []
  ).sort()

const expectedRemoteRejections = (): string[] =>
  RENDERER_CONTRACT_CATALOG.flatMap(({ channel, kind, surfaceInstallation }) =>
    channel !== null &&
    kind === 'method' &&
    surfaceInstallation.localWeb === 'web-rpc' &&
    surfaceInstallation.remoteWeb === 'rejecting-stub'
      ? [channel]
      : []
  ).sort()

const installInstrumentedRouterFactory = (
  events: string[],
  options: Readonly<{
    failInstallAt?: number
    failCompleteAt?: number
    failUninstallAt?: ReadonlySet<number>
    failRouterDispose?: boolean
    registerUnexpectedCommand?: boolean
    skipRegisteredGroup?: string
    onRegisterGroup?: (groupName: string, handlers: unknown) => void
  }> = {}
): void => {
  const actualFactory = routerFactoryControl.actual as unknown as (
    onDiagnostic?: unknown
  ) => ApplicationCommandRouter
  routerFactoryControl.replacement = (onDiagnostic): ApplicationCommandRouter => {
    const router = actualFactory(onDiagnostic)
    let nextScope = 0

    return Object.freeze({
      ...router,
      registrar: Object.freeze({
        createScope: (): ApplicationCommandRegistrationScope => {
          const index = nextScope++
          events.push(`install:${index}`)
          if (options.failInstallAt === index) throw new Error(`install failed:${index}`)
          const scope = router.registrar.createScope()
          const registerGroup: ApplicationCommandRegistrationScope['registerGroup'] = (
            group,
            handlers
          ) => {
            options.onRegisterGroup?.(group.name, handlers)
            if (options.skipRegisteredGroup === group.name) return
            scope.registerGroup(group, handlers)
          }
          return Object.freeze({
            ...scope,
            registerGroup,
            complete: (cleanup): ApplicationCommandInstallation => {
              if (options.registerUnexpectedCommand && index === 0) {
                scope.registerGroup(unexpectedGroup, { 'test:unexpected': () => undefined })
              }
              if (options.failCompleteAt === index) {
                throw new Error(`complete failed:${index}`)
              }
              const installation = scope.complete(cleanup)
              return Object.freeze({
                uninstall: (): void => {
                  events.push(`uninstall:${index}`)
                  installation.uninstall()
                  if (options.failUninstallAt?.has(index)) {
                    throw new Error(`uninstall failed:${index}`)
                  }
                }
              })
            }
          })
        }
      }),
      dispose: (): void => {
        events.push('router:dispose')
        router.dispose()
        if (options.failRouterDispose) throw new Error('router dispose failed')
      }
    })
  }
}

afterEach(() => {
  routerFactoryControl.replacement = undefined
})

const invocation = (
  location: 'local' | 'remote' = 'local'
): ApplicationInvocation<readonly unknown[]> => {
  const callerContext = createCallerContext({
    clientId: 'web-client',
    lifecycleClientId: 'web:web-client',
    leaseId: 'lease-1',
    surface: 'web',
    location,
    principalKind: 'human',
    actionOrigin: 'human'
  })
  return Object.freeze({
    callerContext,
    callerLease: Object.freeze({
      leaseId: callerContext.leaseId,
      generation: 1,
      signal: new AbortController().signal,
      isCurrent: () => true
    }),
    args: Object.freeze([])
  })
}

describe('application command composition', () => {
  it('joins the runtime-validated contracts into the Electron view', () => {
    const composition = createApplicationCommandComposition(dependencies())

    expect(composition.electron.commandNames()).toEqual([
      'acp:discard-unavailable-plan',
      'acp:respond-elicitation',
      'acp:respond-permission',
      'acp:respond-plan',
      'literature:citation-styles',
      'literature:complete-metadata',
      'literature:export-record',
      'literature:format-document',
      'literature:format-references',
      'literature:full-text',
      'literature:get',
      'literature:import-pdf',
      'literature:import-records',
      'literature:jobs',
      'literature:lookup-metadata',
      'literature:search',
      'literature:sources',
      'literature:transact',
      'memory:clear-all',
      'memory:create-category',
      'memory:create-entry',
      'memory:delete-category',
      'memory:delete-entry',
      'memory:set-enabled',
      'memory:snapshot',
      'memory:update-category',
      'memory:update-entry',
      'pdf-structure:cancel',
      'pdf-structure:clear-cache',
      'pdf-structure:parse',
      'pdf-structure:read-thumbnail',
      'projects:create',
      'projects:delete',
      'projects:get',
      'projects:list',
      'projects:list-deletion-cleanup',
      'projects:retry-deletion-cleanup',
      'projects:update',
      'projects:update-archive',
      'sessions:delete-session',
      'sessions:edit-details',
      'sessions:export-package',
      'sessions:filter-pdf-context-candidates',
      'sessions:import-package',
      'sessions:link-pdf-context',
      'sessions:package-operation',
      'sessions:set-delegation-policy',
      'sessions:unlink-pdf-context',
      'sessions:update-archive',
      'tags:create',
      'tags:delete',
      'tags:reorder',
      'tags:set-assignment',
      'tags:snapshot',
      'tags:update',
      'uploads:finalize-session',
      'uploads:recover-draft'
    ])
  })

  it('certifies the complete group inventory behind the local Web view', () => {
    const composition = createApplicationCommandComposition(dependencies())

    expect(composition.localWeb.commandNames()).toEqual(expectedLocalWebCommands())
  })

  it('partitions remote Web dispatch from fail-closed pre-dispatch rejections', async () => {
    const listProjects = vi.fn().mockResolvedValue([project('project-1')])
    const onDiagnostic = vi.fn()
    const composition = createApplicationCommandComposition(
      {
        ...dependencies(),
        dataContent: {
          projects: { list: listProjects },
          withDataRootWrite: async (operation: () => Promise<unknown>) => operation()
        } as never
      },
      onDiagnostic
    )

    expect(composition.remoteWeb.commandNames()).toEqual(expectedRemoteCommands())
    expect(composition.remoteWeb.rejectedCommandNames()).toEqual(expectedRemoteRejections())

    await expect(
      composition.remoteWeb.invoke('compute:download', invocation('remote'))
    ).rejects.toThrow('Application command is rejected before dispatch: compute:download')
    expect(onDiagnostic).not.toHaveBeenCalled()
    await expect(
      composition.remoteWeb.invoke('projects:list', invocation('remote'))
    ).resolves.toEqual([project('project-1')])
    expect(listProjects).toHaveBeenCalledOnce()
  })

  it('exposes only Reviewer run and reads to Task automation', () => {
    const composition = createApplicationCommandComposition(dependencies())
    const reviewerCommands = ['reviewer:abort-fix-loop', 'reviewer:get-for-session', 'reviewer:run']

    expect(composition.localWeb.commandNames()).toEqual(expect.arrayContaining(reviewerCommands))
    expect(composition.remoteWeb.commandNames()).toEqual(expect.arrayContaining(reviewerCommands))
    for (const command of reviewerCommands) {
      expect(composition.remoteWeb.rejectedCommandNames()).not.toContain(command)
    }
    expect(composition.task.commandNames()).toEqual(
      expect.arrayContaining(['reviewer:abort', 'reviewer:get-for-session', 'reviewer:run'])
    )
    expect(composition.task.commandNames()).not.toContain('reviewer:abort-fix-loop')
  })

  it('exposes only the explicit Task commands and no transport-wide capability', async () => {
    const composition = createApplicationCommandComposition(dependencies())

    expect(composition.task.commandNames()).toEqual([
      'settings:bootstrap',
      'cli:install',
      'settings:get-preflight',
      'settings:list-skills',
      'settings:list-connectors',
      'settings:get-connector-detail',
      'settings:set-connector-enabled',
      'settings:set-custom-server-enabled',
      'settings:add-custom-server',
      'settings:update-custom-server',
      'settings:remove-custom-server',
      'settings:test-custom-server',
      'settings:list-device-credentials',
      'settings:create-device-credential',
      'settings:update-device-credential',

      'projects:list',
      'projects:create',
      'projects:update',
      'projects:update-session-defaults',
      'settings:get-settings',
      'settings:set-agent-routing',
      'sessions:load-all',
      'sessions:save-session',
      'sessions:stage-task-completion',
      'sessions:settle-task-completion',
      'sessions:fail-task-run',
      'sessions:set-delegation-policy',
      'sessions:update-configuration',
      'acp:get-plan-projection',
      'acp:respond-plan',
      'reviewer:abort',
      'reviewer:get-for-session',
      'reviewer:run',
      'artifacts:finalize-run',
      'artifacts:resolve-version-descriptors',
      'preview-resources:acquire',
      'preview-resources:release'
    ])
    await expect(
      composition.localWeb.invoke('sessions:export-conversation', invocation())
    ).rejects.toThrow(
      'Application command is unavailable in this view: sessions:export-conversation'
    )
    await expect(composition.task.invoke('cli:get-status', invocation())).rejects.toThrow(
      'Application command is unavailable in this view: cli:get-status'
    )
    expect(composition).not.toHaveProperty('registrar')
    expect(composition).not.toHaveProperty('dispatcher')
    expect(composition).not.toHaveProperty('cli')
    expect(composition).not.toHaveProperty('localRpc')
    expect(composition).not.toHaveProperty('specialist')
  })

  it('late-binds the single Remote Access owner and fails closed around its lifetime', async () => {
    const snapshot = Object.freeze({
      canManage: true,
      canManagePairing: true,
      mode: 'off' as const,
      enabled: false,
      lifecycle: 'disabled' as const,
      remoteIt: Object.freeze({ installed: false, loggedIn: false, registered: false }),
      pendingRequests: Object.freeze([]),
      trustedBrowsers: Object.freeze([])
    })
    const firstSnapshot = vi.fn(() => snapshot)
    const firstOwner = {
      snapshot: firstSnapshot,
      probe: vi.fn(),
      detect: vi.fn(),
      setMode: vi.fn(),
      disable: vi.fn(),
      approve: vi.fn(),
      reject: vi.fn(),
      revoke: vi.fn()
    }
    const replacementSnapshot = vi.fn(() =>
      Object.freeze({ ...snapshot, mode: 'remoteit' as const, enabled: true, lifecycle: 'running' })
    )
    const replacementOwner = { ...firstOwner, snapshot: replacementSnapshot }
    const composition = createApplicationCommandComposition(dependencies())

    await expect(
      composition.remoteWeb.invoke('remote-access:get-snapshot', invocation('remote'))
    ).rejects.toThrow('Remote Access command owner is not bound.')

    composition.bindRemoteAccess(firstOwner as never)
    await expect(
      composition.remoteWeb.invoke('remote-access:get-snapshot', invocation('remote'))
    ).resolves.toBe(snapshot)
    expect(firstSnapshot).toHaveBeenCalledOnce()
    expect(() => composition.bindRemoteAccess(replacementOwner as never)).toThrow(
      'Remote Access command owner is already bound.'
    )
    expect(replacementSnapshot).not.toHaveBeenCalled()

    composition.dispose()
    composition.dispose()
    expect(() => composition.bindRemoteAccess(firstOwner as never)).toThrow(
      'Remote Access command owner slot is disposed.'
    )
    await expect(
      composition.remoteWeb.invoke('remote-access:get-snapshot', invocation('remote'))
    ).rejects.toThrow('Application command router is disposed.')
  })

  it('rejects declared commands that are missing from the installed router inventory', () => {
    const events: string[] = []
    installInstrumentedRouterFactory(events, { skipRegisteredGroup: 'acp' })

    expect(() => createApplicationCommandComposition(dependencies())).toThrow(
      'declared commands are not installed: acp:'
    )
    expect(events.at(-1)).toBe('router:dispose')
  })

  it('rejects installed commands that are missing from the declared inventory', () => {
    const events: string[] = []
    installInstrumentedRouterFactory(events, { registerUnexpectedCommand: true })

    expect(() => createApplicationCommandComposition(dependencies())).toThrow(
      'installed commands are not declared: test:unexpected'
    )
    expect(events.at(-1)).toBe('router:dispose')
  })

  it('installs every command module and stops at a partial failure', () => {
    const source = dependencies()
    const normalEvents: string[] = []
    installInstrumentedRouterFactory(normalEvents)
    const composition = createApplicationCommandComposition(source)
    const installEvents = [...normalEvents]
    const installationCount = installEvents.length
    const lastInstallationIndex = installationCount - 1
    const uninstallEvents = Array.from(
      { length: installationCount },
      (_, index) => `uninstall:${lastInstallationIndex - index}`
    )
    expect(installationCount).toBeGreaterThan(0)
    expect(installEvents).toEqual(
      Array.from({ length: installationCount }, (_, index) => `install:${index}`)
    )
    composition.dispose()
    expect(normalEvents).toEqual([...installEvents, ...uninstallEvents, 'router:dispose'])
    const disposedEventCount = normalEvents.length
    composition.dispose()
    expect(normalEvents).toHaveLength(disposedEventCount)

    const partialEvents: string[] = []
    installInstrumentedRouterFactory(partialEvents, { failInstallAt: 4 })
    expect(() => createApplicationCommandComposition(source)).toThrow('install failed:4')
    expect(partialEvents).toEqual([
      'install:0',
      'install:1',
      'install:2',
      'install:3',
      'install:4',
      'uninstall:3',
      'uninstall:2',
      'uninstall:1',
      'uninstall:0',
      'router:dispose'
    ])

    const cleanupFailureEvents: string[] = []
    installInstrumentedRouterFactory(cleanupFailureEvents, {
      failInstallAt: 4,
      failUninstallAt: new Set([3, 1]),
      failRouterDispose: true
    })
    let constructionFailure: unknown
    try {
      createApplicationCommandComposition(source)
    } catch (error) {
      constructionFailure = error
    }
    expect(constructionFailure).toBeInstanceOf(AggregateError)
    expect(
      (constructionFailure as AggregateError).errors.map((error) => (error as Error).message)
    ).toEqual([
      'install failed:4',
      'uninstall failed:3',
      'uninstall failed:1',
      'router dispose failed'
    ])
    expect(cleanupFailureEvents.slice(5)).toEqual([
      'uninstall:3',
      'uninstall:2',
      'uninstall:1',
      'uninstall:0',
      'router:dispose'
    ])

    const disposeFailureEvents: string[] = []
    let disposedRemoteAccessHandler:
      ((invocation: ApplicationInvocation<readonly unknown[]>) => unknown) | undefined
    installInstrumentedRouterFactory(disposeFailureEvents, {
      failUninstallAt: new Set([lastInstallationIndex, 3]),
      failRouterDispose: true,
      onRegisterGroup: (groupName, handlers) => {
        if (groupName !== 'remote-access') return
        disposedRemoteAccessHandler = (
          handlers as Record<
            string,
            (invocation: ApplicationInvocation<readonly unknown[]>) => unknown
          >
        )['remote-access:get-snapshot']
      }
    })
    const disposeFailure = createApplicationCommandComposition(source)
    let disposalFailure: unknown
    try {
      disposeFailure.dispose()
    } catch (error) {
      disposalFailure = error
    }
    expect(disposalFailure).toBeInstanceOf(AggregateError)
    expect(
      (disposalFailure as AggregateError).errors.map((error) => (error as Error).message)
    ).toEqual([
      `uninstall failed:${lastInstallationIndex}`,
      'uninstall failed:3',
      'router dispose failed'
    ])
    expect(disposeFailureEvents.slice(installationCount)).toEqual([
      ...uninstallEvents,
      'router:dispose'
    ])
    expect(() => disposeFailure.dispose()).not.toThrow()
    expect(() => disposedRemoteAccessHandler?.(invocation('remote'))).toThrow(
      'Remote Access command owner slot is disposed.'
    )

    let remoteAccessHandler:
      ((invocation: ApplicationInvocation<readonly unknown[]>) => unknown) | undefined
    const slotFailureEvents: string[] = []
    installInstrumentedRouterFactory(slotFailureEvents, {
      failCompleteAt: lastInstallationIndex,
      failRouterDispose: true,
      onRegisterGroup: (groupName, handlers) => {
        if (groupName !== 'remote-access') return
        remoteAccessHandler = (
          handlers as Record<
            string,
            (invocation: ApplicationInvocation<readonly unknown[]>) => unknown
          >
        )['remote-access:get-snapshot']
      }
    })
    let slotConstructionFailure: unknown
    try {
      createApplicationCommandComposition(source)
    } catch (error) {
      slotConstructionFailure = error
    }
    expect(slotConstructionFailure).toBeInstanceOf(AggregateError)
    expect(
      (slotConstructionFailure as AggregateError).errors.map((error) => (error as Error).message)
    ).toEqual([`complete failed:${lastInstallationIndex}`, 'router dispose failed'])
    expect(slotFailureEvents.slice(installationCount)).toEqual([
      ...uninstallEvents.slice(1),
      'router:dispose'
    ])
    expect(() => remoteAccessHandler?.(invocation('remote'))).toThrow(
      'Remote Access command owner slot is disposed.'
    )
  })

  it('routes different narrow views through one shared command owner', async () => {
    const listProjects = vi
      .fn()
      .mockResolvedValueOnce([project('from-local-web')])
      .mockResolvedValueOnce([project('from-task')])
    const composition = createApplicationCommandComposition({
      ...dependencies(),
      dataContent: {
        projects: { list: listProjects },
        withDataRootWrite: async (operation: () => Promise<unknown>) => operation()
      } as never
    })

    await expect(composition.localWeb.invoke('projects:list', invocation())).resolves.toEqual([
      project('from-local-web')
    ])
    await expect(composition.task.invoke('projects:list', invocation())).resolves.toEqual([
      project('from-task')
    ])
    expect(listProjects).toHaveBeenCalledTimes(2)
  })
})

it('routes Task Connector reads to the existing Settings owner without adding Web diagnostics', async () => {
  const snapshot = { connectors: [], customServers: [], ncbi: { hasApiKey: false } }
  const listConnectors = vi.fn(async () => snapshot)
  const composition = createApplicationCommandComposition({
    ...dependencies(),
    settingsCore: { service: { listConnectors } } as never
  })
  await expect(composition.task.invoke('settings:list-connectors', invocation())).resolves.toEqual(
    snapshot
  )
  expect(listConnectors).toHaveBeenCalledOnce()
  expect(composition.localWeb.commandNames()).not.toContain('settings:test-custom-server')
  expect(composition.remoteWeb.commandNames()).not.toContain('settings:test-custom-server')
  composition.dispose()
})

it('routes Task doctor prerequisites to the existing Settings owners', async () => {
  const preflight = {
    claudeReady: false,
    opencodeReady: false,
    codebuddyReady: false,
    codexReady: true,
    agentFrameworkId: 'codex',
    agentReady: true,
    activeProviderReady: true
  }
  const skills = [{ id: 'literature-review' }]
  const getPreflight = vi.fn(async () => preflight)
  const listSkills = vi.fn(async () => skills)
  const composition = createApplicationCommandComposition({
    ...dependencies(),
    settingsCore: { service: { getPreflight, listSkills } } as never
  })

  await expect(composition.task.invoke('settings:get-preflight', invocation())).resolves.toEqual(
    preflight
  )
  await expect(composition.task.invoke('settings:list-skills', invocation())).resolves.toEqual(
    skills
  )
  composition.dispose()
})

it('validates bounded reference exports through the shared Web command boundary', async () => {
  const exported = { chunk: '{"title":"Reference"}', digest: 'a'.repeat(64) }
  const exportRecord = vi.fn(async () => exported)
  const composition = createApplicationCommandComposition({
    ...dependencies(),
    literature: { exportRecord } as never
  })
  await expect(
    composition.localWeb.invoke('literature:export-record', {
      ...invocation(),
      args: [{ itemId: 'reference', offset: -1 }]
    })
  ).rejects.toThrow()
  expect(exportRecord).not.toHaveBeenCalled()
  await expect(
    composition.remoteWeb.invoke('literature:export-record', {
      ...invocation('remote'),
      args: [{ itemId: 'reference' }]
    })
  ).resolves.toEqual(exported)
  expect(exportRecord).toHaveBeenCalledWith({ itemId: 'reference' })
  composition.dispose()
})

describe('TB-01 remote preview admission', () => {
  it.each([
    ['remote', 'local'],
    ['local', 'local'],
    ['remote', 'literature'],
    ['remote', 'notebook-input']
  ] as const)('enforces %s caller admission for %s preview sources', async (surface, source) => {
    const location = surface === 'remote' ? 'remote' : 'local'
    const directory = await mkdtemp(join(tmpdir(), 'preview-admission-'))
    const path = join(directory, 'outside-project.txt')
    const content = 'host-only-test-content'
    await writeFile(path, content)
    const localFs = new LocalFsService()
    const resolvePath = vi.fn(async (_source, request) => localFs.resolveFilePath(request))
    const trustedLease = {
      path,
      size: content.length,
      versionToken: 1,
      snapshot: { dev: 1n, ino: 1n, size: BigInt(content.length), mtimeNs: 1n },
      read: vi.fn(),
      readRange: async (begin: number, end: number) => Buffer.from(content).subarray(begin, end),
      verifyUnchanged: async () => undefined,
      close: async () => undefined
    }
    const resources = new ManagedPreviewResources({
      resolvePath,
      openLiterature: async () => trustedLease,
      openNotebookInput: async () => trustedLease
    })
    const owners = createManagedPreviewOwnerRegistry(resources)
    const deps = dependencies()
    const composition = createApplicationCommandComposition({
      ...deps,
      dataContent: { ...deps.dataContent, managedPreview: owners }
    })
    const leases = new ApplicationCallerLeaseRegistry()
    const initial = invocation(location)
    const caller = { ...initial, callerLease: leases.acquire(initial.callerContext).lease }
    const dispatcher = location === 'remote' ? composition.remoteWeb : composition.localWeb
    let resource: ManagedPreviewResource | undefined
    try {
      const acquired = dispatcher.invoke('preview-resources:acquire', {
        ...caller,
        args: [{ source, path }]
      }) as Promise<ManagedPreviewResource>
      if (location === 'remote' && source === 'local') {
        // Capture actual bytes if admission unexpectedly succeeds, without hiding the failed guard.
        resource = await acquired.catch(() => undefined)
        if (resource) {
          const range = (await dispatcher.invoke('preview-resources:read-range', {
            ...caller,
            args: [{ resourceId: resource.id, begin: 0, end: content.length }]
          })) as ManagedPreviewRangeResult
          expect
            .soft(Buffer.from(range.data).toString(), 'remote caller received host-only bytes')
            .not.toBe(content)
        }
        await expect.soft(acquired).rejects.toThrow(/local app/)
        expect.soft(resource, 'remote local-file request must be rejected').toBeUndefined()
        expect(resolvePath, 'reject before filesystem resolution').not.toHaveBeenCalled()
      } else {
        resource = await acquired
        const range = (await dispatcher.invoke('preview-resources:read-range', {
          ...caller,
          args: [{ resourceId: resource.id, begin: 0, end: content.length }]
        })) as ManagedPreviewRangeResult
        expect(Buffer.from(range.data).toString()).toBe(content)
      }
    } finally {
      if (resource) owners.release(caller.callerLease, { resourceId: resource.id })
      leases.dispose()
      composition.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
