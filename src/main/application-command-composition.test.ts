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
import {
  createApplicationCommandComposition,
  type ApplicationCommandCompositionDependencies
} from './application-command-composition'
import {
  type ApplicationCommandInstallation,
  type ApplicationCommandRouter,
  type ApplicationCommandRegistrationScope,
  type ApplicationInvocation
} from './application-command-router'
import { createCallerContext } from './caller-context'

const EMPTY_OWNER = Object.freeze({})

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
            scope.registerGroup(group, handlers)
          }
          return Object.freeze({
            ...scope,
            registerGroup,
            complete: (cleanup): ApplicationCommandInstallation => {
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
  it('certifies the complete group inventory behind the local Web view', () => {
    const composition = createApplicationCommandComposition(dependencies())

    expect(composition.localWeb.commandNames()).toEqual(expectedLocalWebCommands())
    expect(composition.localWeb.commandNames()).toHaveLength(217)
  })

  it('partitions remote Web dispatch from fail-closed pre-dispatch rejections', async () => {
    const listProjects = vi.fn().mockResolvedValue([{ id: 'project-1' }])
    const onDiagnostic = vi.fn()
    const composition = createApplicationCommandComposition(
      {
        ...dependencies(),
        dataContent: { projects: { list: listProjects } } as never
      },
      onDiagnostic
    )

    expect(composition.remoteWeb.commandNames()).toEqual(expectedRemoteCommands())
    expect(composition.remoteWeb.commandNames()).toHaveLength(161)
    expect(composition.remoteWeb.rejectedCommandNames()).toEqual(expectedRemoteRejections())
    expect(composition.remoteWeb.rejectedCommandNames()).toHaveLength(56)
    await expect(
      composition.remoteWeb.invoke('compute:download', invocation('remote'))
    ).rejects.toThrow('Application command is rejected before dispatch: compute:download')
    expect(onDiagnostic).not.toHaveBeenCalled()
    await expect(
      composition.remoteWeb.invoke('projects:list', invocation('remote'))
    ).resolves.toEqual([{ id: 'project-1' }])
    expect(listProjects).toHaveBeenCalledOnce()
  })

  it('exposes only the seven Task commands and no transport-wide capability', async () => {
    const composition = createApplicationCommandComposition(dependencies())

    expect(composition.task.commandNames()).toEqual([
      'projects:list',
      'projects:create',
      'sessions:load-all',
      'sessions:save-session',
      'artifacts:finalize-run',
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
    expect(composition).not.toHaveProperty('electron')
    expect(composition).not.toHaveProperty('cli')
    expect(composition).not.toHaveProperty('localRpc')
    expect(composition).not.toHaveProperty('specialist')
  })

  it('late-binds the single Remote Access owner and fails closed around its lifetime', async () => {
    const snapshot = Object.freeze({ lifecycle: 'disabled' })
    const firstSnapshot = vi.fn(() => snapshot)
    const firstOwner = {
      snapshot: firstSnapshot,
      detect: vi.fn(),
      setMode: vi.fn(),
      disable: vi.fn(),
      approve: vi.fn(),
      reject: vi.fn(),
      revoke: vi.fn()
    }
    const replacementSnapshot = vi.fn(() => Object.freeze({ lifecycle: 'running' }))
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

  it('installs every registrar family in a fixed order and stops at a partial failure', () => {
    const orderedNames = [
      'acp',
      'notebook',
      'notebookEnvironment',
      'notebookRuntime',
      'settingsCore',
      'settingsIntegration',
      'settingsRuntime',
      'compute',
      'permissionGrants',
      'dataContent',
      'host'
    ] as const satisfies readonly (keyof ApplicationCommandCompositionDependencies)[]
    const source = dependencies()
    const reads: string[] = []
    const ordered = Object.create(null) as ApplicationCommandCompositionDependencies
    for (const name of orderedNames) {
      Object.defineProperty(ordered, name, {
        enumerable: true,
        get: () => {
          reads.push(name)
          return source[name]
        }
      })
    }

    const normalEvents: string[] = []
    installInstrumentedRouterFactory(normalEvents)
    const composition = createApplicationCommandComposition(ordered)
    expect(reads).toEqual(orderedNames)
    expect(normalEvents).toEqual(orderedNames.map((_, index) => `install:${index}`))
    composition.dispose()
    expect(normalEvents.slice(11)).toEqual([
      'uninstall:10',
      'uninstall:9',
      'uninstall:8',
      'uninstall:7',
      'uninstall:6',
      'uninstall:5',
      'uninstall:4',
      'uninstall:3',
      'uninstall:2',
      'uninstall:1',
      'uninstall:0',
      'router:dispose'
    ])
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
      failUninstallAt: new Set([10, 3]),
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
    ).toEqual(['uninstall failed:10', 'uninstall failed:3', 'router dispose failed'])
    expect(disposeFailureEvents.slice(11)).toEqual([
      'uninstall:10',
      'uninstall:9',
      'uninstall:8',
      'uninstall:7',
      'uninstall:6',
      'uninstall:5',
      'uninstall:4',
      'uninstall:3',
      'uninstall:2',
      'uninstall:1',
      'uninstall:0',
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
      failCompleteAt: 10,
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
    ).toEqual(['complete failed:10', 'router dispose failed'])
    expect(slotFailureEvents.slice(11)).toEqual([
      'uninstall:9',
      'uninstall:8',
      'uninstall:7',
      'uninstall:6',
      'uninstall:5',
      'uninstall:4',
      'uninstall:3',
      'uninstall:2',
      'uninstall:1',
      'uninstall:0',
      'router:dispose'
    ])
    expect(() => remoteAccessHandler?.(invocation('remote'))).toThrow(
      'Remote Access command owner slot is disposed.'
    )
  })

  it('routes different narrow views through one shared command owner', async () => {
    const listProjects = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'from-local-web' }])
      .mockResolvedValueOnce([{ id: 'from-task' }])
    const composition = createApplicationCommandComposition({
      ...dependencies(),
      dataContent: { projects: { list: listProjects } } as never
    })

    await expect(composition.localWeb.invoke('projects:list', invocation())).resolves.toEqual([
      { id: 'from-local-web' }
    ])
    await expect(composition.task.invoke('projects:list', invocation())).resolves.toEqual([
      { id: 'from-task' }
    ])
    expect(listProjects).toHaveBeenCalledTimes(2)
  })
})
