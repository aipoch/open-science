import { describe, expect, it, vi } from 'vitest'

import {
  AGENT_RUNTIME_UPDATE_FIXTURE,
  SKILL_IMPORT_APPROVAL_FIXTURE,
  TERMINAL_EVENT_FIXTURE
} from '../../test/fixtures/renderer-contract-certification'

import {
  canAccessSessionPlan,
  canSatisfyHumanApproval,
  createElectronCallerContext,
  createTaskCallerContext,
  createWebCallerContext
} from '../main/caller-context'
import { ApplicationEventHub, type ApplicationEvent } from '../main/application-events'
import {
  projectPublicTaskEvent,
  projectTaskRuntimeEvent,
  projectWebRendererEvent
} from '../main/web-service/application-event-projections'
import { REMOTE_LOCAL_ONLY_RPC_CHANNELS } from '../main/web-service/http-server'
import { createElectronRendererContractAdapter } from '../preload/electron-renderer-contract-adapter'
import { installWebRendererContracts } from '../renderer/web/api-installer'
import { RENDERER_CONTRACT_CATALOG } from './renderer-contract-catalog'
import { SPECIALIST_IPC } from './specialist'
import type { StartTaskRunRequest } from './task-api'
import { WEB_EVENT_CHANNELS, WEB_INVOKE_CHANNELS } from './web-api-map.generated'
import { isWebRpcChannel, isWebRpcEventChannel } from './web-rpc-contract'

const TASK_RUN_REQUEST_FIELDS = {
  project: true,
  prompt: true,
  cwd: true,
  sessionId: true,
  permissionProfile: true,
  skillIds: true,
  turnIntent: true,
  autoReviewEnabled: true,
  specialist: true,
  delegationPolicy: true,
  computeHostIds: true
} as const satisfies Record<keyof StartTaskRunRequest, true>

const permissionPaths = [
  'acp.respondToPermission',
  'acp.revokePermissionGrant',
  'acp.setPermissionProfile',
  'permissions.extendUndo',
  'permissions.list',
  'permissions.restore',
  'permissions.restoreDefaults',
  'permissions.revoke'
] as const

const permissionEventPaths = ['acp.onPermissionRequest', 'permissions.onChanged'] as const

const computePaths = [
  'compute.bookmarksGet',
  'compute.bookmarksSet',
  'compute.changeAuthentication',
  'compute.concurrencySet',
  'compute.create',
  'compute.createPassword',
  'compute.delete',
  'compute.deletionStatus',
  'compute.detailsGet',
  'compute.detailsSave',
  'compute.download',
  'compute.enabledHostsGet',
  'compute.enabledHostsSet',
  'compute.get',
  'compute.hostEnabledSet',
  'compute.hostSelectedSet',
  'compute.jobsCancel',
  'compute.jobsList',
  'compute.jobsMarkConsumed',
  'compute.jobsPendingNotification',
  'compute.jobsSetRemoteCleanup',
  'compute.jobsTransitionAnalysis',
  'compute.list',
  'compute.listDir',
  'compute.passwordCapability',
  'compute.probe',
  'compute.replayApproval',
  'compute.replayPendingApprovals',
  'compute.resetPassword',
  'compute.respondApproval',
  'compute.revealInFolder',
  'compute.scratchClear',
  'compute.scratchSet',
  'compute.sshConfigAliases'
] as const

const computeEventPaths = [
  'compute.onApprovalRequest',
  'compute.onApprovalSettled',
  'compute.onJobUpdated'
] as const

const pathsWithPrefix = (paths: readonly string[], prefix: string): string[] =>
  paths.filter((path) => path.startsWith(prefix)).sort()

const projectThroughRendererAdapters = (
  publicPath: string,
  channel: string,
  payload: unknown
): { electronPayload: unknown; webPayload: unknown } => {
  let electronIpcListener: ((event: unknown, payload: unknown) => void) | undefined
  let electronPayload: unknown
  const electronPort = {
    invoke: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    on: vi.fn((ch, listener) => (electronIpcListener = ch === channel ? listener : undefined)),
    removeListener: vi.fn(),
    getPathForFile: vi.fn(() => '')
  }
  createElectronRendererContractAdapter(electronPort).subscribe(
    publicPath,
    (value) => (electronPayload = value)
  )
  electronIpcListener?.({}, payload)

  let webIpcListener: ((payload: unknown) => void) | undefined
  let webPayload: unknown
  const webApi: Record<string, unknown> = {}
  installWebRendererContracts(webApi, {
    availableRpcChannels: new Set(),
    restrictedRpcChannels: new Set(),
    invoke: vi.fn(),
    subscribe: (installedChannel, listener) => {
      if (installedChannel === channel) webIpcListener = listener
      return vi.fn()
    },
    nativeAdapters: {}
  })
  const webSubscribe = publicPath
    .split('.')
    .reduce<unknown>((value, member) => (value as Record<string, unknown>)[member], webApi) as (
    listener: (value: unknown) => void
  ) => void
  webSubscribe((value) => (webPayload = value))
  webIpcListener?.(payload)

  return { electronPayload, webPayload }
}

describe('renderer surface compatibility matrix', () => {
  it('publishes the authoritative Session delegation mutation on Electron and both Web locations', () => {
    expect(
      RENDERER_CONTRACT_CATALOG.find(
        ({ publicPath }) => publicPath === 'sessions.setDelegationPolicy'
      )
    ).toMatchObject({
      channel: 'sessions:set-delegation-policy',
      applicationCommand: 'runtime-validated',
      surfaceInstallation: {
        electron: 'preload',
        localWeb: 'web-rpc',
        remoteWeb: 'web-rpc'
      },
      authorityFlow: {
        electron: 'electron-sender',
        localWeb: 'caller-context',
        remoteWeb: 'caller-context'
      }
    })
    expect(WEB_INVOKE_CHANNELS['sessions.setDelegationPolicy']).toBe(
      'sessions:set-delegation-policy'
    )
  })

  it('derives remote Web rejecting channels from the renderer catalog', () => {
    const expected = RENDERER_CONTRACT_CATALOG.flatMap(({ channel, surfaceInstallation }) =>
      channel !== null &&
      surfaceInstallation.localWeb === 'web-rpc' &&
      surfaceInstallation.remoteWeb === 'rejecting-stub'
        ? [channel]
        : []
    ).sort()

    expect([...REMOTE_LOCAL_ONLY_RPC_CHANNELS].sort()).toEqual(expected)
  })

  it('keeps Specialist management and pending-switch delivery Electron-only', () => {
    const invokePaths = Object.keys(WEB_INVOKE_CHANNELS)
    const eventPaths = Object.keys(WEB_EVENT_CHANNELS)
    const specialistChannels = Object.values(SPECIALIST_IPC)

    expect(pathsWithPrefix(invokePaths, 'specialist.')).toEqual([])
    expect(pathsWithPrefix(eventPaths, 'specialist.')).toEqual([])
    expect(specialistChannels.every((channel) => !isWebRpcChannel(channel))).toBe(true)
    expect(specialistChannels.every((channel) => !isWebRpcEventChannel(channel))).toBe(true)

    const hub = new ApplicationEventHub()
    const installedEvents: ApplicationEvent[] = []
    hub.subscribe((event) => installedEvents.push(event))
    hub.publish('specialist:catalog-changed', undefined)
    hub.publish('specialist:pending-switch', {
      sessionId: 'session-1',
      targetName: 'ANALYST'
    })

    expect(installedEvents.map((event) => event.channel)).toEqual([
      'specialist:catalog-changed',
      'specialist:pending-switch'
    ])
    for (const event of installedEvents) {
      expect(projectWebRendererEvent(event)).toBeUndefined()
      expect(projectPublicTaskEvent(event)).toBeUndefined()
      expect(projectTaskRuntimeEvent(event)).toBeUndefined()
    }
  })

  it('keeps Permission available on Electron and both Web locations without granting Task human authority', () => {
    const invokePaths = Object.keys(WEB_INVOKE_CHANNELS)
    const eventPaths = Object.keys(WEB_EVENT_CHANNELS)

    expect(
      pathsWithPrefix(invokePaths, 'permissions.').map(
        (path) => path as (typeof permissionPaths)[number]
      )
    ).toEqual(permissionPaths.filter((path) => path.startsWith('permissions.')))
    expect(permissionPaths.map((path) => WEB_INVOKE_CHANNELS[path])).toEqual([
      'acp:respond-permission',
      'acp:revoke-permission-grant',
      'acp:set-permission-profile',
      'permissions:extend-undo',
      'permissions:list',
      'permissions:restore',
      'permissions:restore-defaults',
      'permissions:revoke'
    ])
    expect(permissionPaths.map((path) => WEB_INVOKE_CHANNELS[path]).every(isWebRpcChannel)).toBe(
      true
    )
    expect(permissionEventPaths.map((path) => WEB_EVENT_CHANNELS[path])).toEqual([
      'acp:permission-request',
      'permissions:changed'
    ])
    expect(
      permissionEventPaths.map((path) => WEB_EVENT_CHANNELS[path]).every(isWebRpcEventChannel)
    ).toBe(true)
    expect(pathsWithPrefix(eventPaths, 'permissions.')).toEqual(['permissions.onChanged'])
    expect(
      permissionPaths
        .map((path) => WEB_INVOKE_CHANNELS[path])
        .filter((channel) => REMOTE_LOCAL_ONLY_RPC_CHANNELS.has(channel))
    ).toEqual([])

    expect(canSatisfyHumanApproval(createElectronCallerContext(1))).toBe(true)
    expect(canSatisfyHumanApproval(createWebCallerContext('local-browser'))).toBe(true)
    expect(
      canSatisfyHumanApproval(createWebCallerContext('remote-browser', { location: 'remote' }))
    ).toBe(true)
    expect(canSatisfyHumanApproval(createTaskCallerContext())).toBe(false)
    expect(canAccessSessionPlan(createTaskCallerContext())).toBe(true)
    expect(
      canSatisfyHumanApproval(
        createWebCallerContext('expired-browser', {
          location: 'remote',
          isAuthorizationCurrent: () => false
        })
      )
    ).toBe(false)
    expect(Object.keys(TASK_RUN_REQUEST_FIELDS).sort()).toEqual([
      'autoReviewEnabled',
      'computeHostIds',
      'cwd',
      'delegationPolicy',
      'permissionProfile',
      'project',
      'prompt',
      'sessionId',
      'skillIds',
      'specialist',
      'turnIntent'
    ])
  })

  it('keeps Compute complete locally and rejects local-only credential and deletion commands on remote Web', async () => {
    const invokePaths = Object.keys(WEB_INVOKE_CHANNELS)
    const eventPaths = Object.keys(WEB_EVENT_CHANNELS)

    expect(pathsWithPrefix(invokePaths, 'compute.')).toEqual(computePaths)
    expect(computePaths.map((path) => WEB_INVOKE_CHANNELS[path]).every(isWebRpcChannel)).toBe(true)
    expect(pathsWithPrefix(eventPaths, 'compute.')).toEqual(computeEventPaths)
    expect(computeEventPaths.map((path) => WEB_EVENT_CHANNELS[path])).toEqual([
      'compute:approval-request',
      'compute:approval-settled',
      'compute:job-updated'
    ])

    const remoteRestrictedCompute = computePaths
      .map((path) => WEB_INVOKE_CHANNELS[path])
      .filter((channel) => REMOTE_LOCAL_ONLY_RPC_CHANNELS.has(channel))
    expect(remoteRestrictedCompute).toEqual([
      'compute:change-authentication',
      'compute:create-password',
      'compute:download',
      'compute:jobs:set-remote-cleanup',
      'compute:password-capability',
      'compute:reset-password',
      'compute:reveal-in-folder'
    ])

    const remoteApi: Record<string, unknown> = {}
    installWebRendererContracts(remoteApi, {
      availableRpcChannels: new Set(),
      restrictedRpcChannels: new Set(remoteRestrictedCompute),
      invoke: async () => undefined,
      subscribe: () => () => undefined,
      nativeAdapters: {}
    })
    const remoteCompute = remoteApi.compute as {
      changeAuthentication(): Promise<unknown>
      createPassword(): Promise<unknown>
      download(): Promise<unknown>
      jobsSetRemoteCleanup(): Promise<unknown>
      passwordCapability(): Promise<unknown>
      resetPassword(): Promise<unknown>
      revealInFolder(): Promise<unknown>
    }
    await expect(remoteCompute.changeAuthentication()).rejects.toThrow(
      'This action is only available in the local desktop app (compute:change-authentication).'
    )
    await expect(remoteCompute.createPassword()).rejects.toThrow(
      'This action is only available in the local desktop app (compute:create-password).'
    )
    await expect(remoteCompute.download()).rejects.toThrow(
      'This action is only available in the local desktop app (compute:download).'
    )
    await expect(remoteCompute.jobsSetRemoteCleanup()).rejects.toThrow(
      'This action is only available in the local desktop app (compute:jobs:set-remote-cleanup).'
    )
    await expect(remoteCompute.revealInFolder()).rejects.toThrow(
      'This action is only available in the local desktop app (compute:reveal-in-folder).'
    )
    await expect(remoteCompute.passwordCapability()).rejects.toThrow(
      'This action is only available in the local desktop app (compute:password-capability).'
    )
    await expect(remoteCompute.resetPassword()).rejects.toThrow(
      'This action is only available in the local desktop app (compute:reset-password).'
    )
  })

  it('keeps projectFiles.searchArtifacts on local and remote Web', () => {
    expect(WEB_INVOKE_CHANNELS['projectFiles.searchArtifacts']).toBe(
      'project-files:search-artifacts'
    )
    expect(isWebRpcChannel('project-files:search-artifacts')).toBe(true)
    expect(REMOTE_LOCAL_ONLY_RPC_CHANNELS.has('project-files:search-artifacts')).toBe(false)
  })

  it('passes complete terminal metadata through Electron, Web, and Task without recomputation', () => {
    const event: ApplicationEvent<'acp:event'> = {
      channel: 'acp:event',
      payload: [TERMINAL_EVENT_FIXTURE]
    }
    const webEvent = projectWebRendererEvent(event)
    expect(webEvent).toMatchObject({ protocolVersion: 1, channel: 'acp:event' })
    const projected = projectThroughRendererAdapters('acp.onEvent', 'acp:event', webEvent?.payload)

    expect(projected.electronPayload).toEqual([TERMINAL_EVENT_FIXTURE])
    expect(projected.webPayload).toEqual([TERMINAL_EVENT_FIXTURE])
    expect(projectTaskRuntimeEvent(event)).toEqual(TERMINAL_EVENT_FIXTURE)
    expect(
      projectPublicTaskEvent(event, (sessionId) => ({
        runId: 'run-1',
        sessionId,
        projectId: 'project-1'
      }))
    ).toEqual({
      runId: 'run-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      type: 'run.event',
      data: TERMINAL_EVENT_FIXTURE
    })
  })

  it('passes scoped Agent Runtime Segment events through Electron and Web unchanged', () => {
    const event: ApplicationEvent<'acp:agent-runtime-update'> = {
      channel: 'acp:agent-runtime-update',
      payload: AGENT_RUNTIME_UPDATE_FIXTURE
    }
    const webEvent = projectWebRendererEvent(event)
    expect(webEvent).toMatchObject({
      protocolVersion: 1,
      channel: 'acp:agent-runtime-update'
    })

    const projected = projectThroughRendererAdapters(
      'acp.onAgentRuntimeUpdate',
      'acp:agent-runtime-update',
      webEvent?.payload
    )
    expect(projected.electronPayload).toEqual(AGENT_RUNTIME_UPDATE_FIXTURE)
    expect(projected.webPayload).toEqual(AGENT_RUNTIME_UPDATE_FIXTURE)
  })

  it('preserves Skill import approval identity on Electron/Web and excludes Task', () => {
    const event: ApplicationEvent<'skills:conversation-import-request'> = {
      channel: 'skills:conversation-import-request',
      payload: SKILL_IMPORT_APPROVAL_FIXTURE
    }
    const webEvent = projectWebRendererEvent(event)
    const projected = projectThroughRendererAdapters(
      'settings.onSkillImportApprovalRequest',
      'skills:conversation-import-request',
      webEvent?.payload
    )

    expect(projected.electronPayload).toBe(SKILL_IMPORT_APPROVAL_FIXTURE)
    expect(projected.webPayload).toBe(SKILL_IMPORT_APPROVAL_FIXTURE)
    expect(projectTaskRuntimeEvent(event)).toBeUndefined()
    expect(projectPublicTaskEvent(event)).toBeUndefined()
  })
})
