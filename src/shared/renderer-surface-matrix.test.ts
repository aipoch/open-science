import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
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
import { installWebInvokeChannels } from '../renderer/web/api-installer'
import type { AcpRuntimeEvent } from './acp'
import { SPECIALIST_IPC } from './specialist'
import { WEB_EVENT_CHANNELS, WEB_INVOKE_CHANNELS } from './web-api-map.generated'
import { isWebRpcChannel, isWebRpcEventChannel } from './web-rpc-contract'

const permissionPaths = [
  'acp.respondToPermission',
  'acp.revokePermissionGrant',
  'acp.setPermissionProfile',
  'permissions.extendUndo',
  'permissions.list',
  'permissions.restore',
  'permissions.revoke'
] as const

const permissionEventPaths = ['acp.onPermissionRequest', 'permissions.onChanged'] as const

const computePaths = [
  'compute.bookmarksGet',
  'compute.bookmarksSet',
  'compute.concurrencySet',
  'compute.create',
  'compute.delete',
  'compute.detailsGet',
  'compute.detailsSave',
  'compute.download',
  'compute.enabledHostsGet',
  'compute.enabledHostsSet',
  'compute.get',
  'compute.jobsList',
  'compute.jobsMarkConsumed',
  'compute.jobsPendingNotification',
  'compute.list',
  'compute.listDir',
  'compute.probe',
  'compute.respondApproval',
  'compute.revealInFolder',
  'compute.scratchSet',
  'compute.sshConfigAliases'
] as const

const computeEventPaths = ['compute.onApprovalRequest', 'compute.onJobUpdated'] as const

const source = (path: string): Promise<string> => readFile(resolve(path), 'utf8')

const pathsWithPrefix = (paths: readonly string[], prefix: string): string[] =>
  paths.filter((path) => path.startsWith(prefix)).sort()

describe('renderer surface compatibility matrix', () => {
  it('keeps Specialist management and pending-switch delivery Electron-only', async () => {
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

    const [preloadSource, rendererBroadcastSource] = await Promise.all([
      source('src/preload/index.ts'),
      source('src/main/renderer-broadcast.ts')
    ])
    expect(preloadSource).toContain('specialist: {')
    expect(preloadSource).toContain(
      'onPendingSwitch: (listener) => onIpcMessage(SPECIALIST_IPC.PENDING_SWITCH, listener)'
    )
    // Electron receives every installed application event; only the Web projection applies an
    // allowlist. This is intentionally different from an event that was never installed.
    expect(rendererBroadcastSource).toContain('projectToElectron(event.channel, event.payload)')
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
    expect(
      canSatisfyHumanApproval(
        createWebCallerContext('expired-browser', {
          location: 'remote',
          isAuthorizationCurrent: () => false
        })
      )
    ).toBe(false)
  })

  it('keeps Compute complete locally and rejects only native download/reveal on remote Web', async () => {
    const invokePaths = Object.keys(WEB_INVOKE_CHANNELS)
    const eventPaths = Object.keys(WEB_EVENT_CHANNELS)

    expect(pathsWithPrefix(invokePaths, 'compute.')).toEqual(computePaths)
    expect(computePaths.map((path) => WEB_INVOKE_CHANNELS[path]).every(isWebRpcChannel)).toBe(true)
    expect(pathsWithPrefix(eventPaths, 'compute.')).toEqual(computeEventPaths)
    expect(computeEventPaths.map((path) => WEB_EVENT_CHANNELS[path])).toEqual([
      'compute:approval-request',
      'compute:job-updated'
    ])

    const remoteRestrictedCompute = computePaths
      .map((path) => WEB_INVOKE_CHANNELS[path])
      .filter((channel) => REMOTE_LOCAL_ONLY_RPC_CHANNELS.has(channel))
    expect(remoteRestrictedCompute).toEqual(['compute:download', 'compute:reveal-in-folder'])

    const remoteApi: Record<string, unknown> = {}
    installWebInvokeChannels(
      remoteApi,
      {
        'compute.download': WEB_INVOKE_CHANNELS['compute.download'],
        'compute.revealInFolder': WEB_INVOKE_CHANNELS['compute.revealInFolder']
      },
      new Set(),
      new Set(remoteRestrictedCompute),
      () => async () => undefined
    )
    const remoteCompute = remoteApi.compute as {
      download(): Promise<unknown>
      revealInFolder(): Promise<unknown>
    }
    await expect(remoteCompute.download()).rejects.toThrow(
      'This action is only available in the local desktop app (compute:download).'
    )
    await expect(remoteCompute.revealInFolder()).rejects.toThrow(
      'This action is only available in the local desktop app (compute:reveal-in-folder).'
    )
  })

  it('keeps CLI, Task, SDK, and local RPC capability subsets explicit', async () => {
    const [cliSource, sdkSource, taskContractSource, localRpcSource] = await Promise.all([
      source('packages/open-science/cli.mjs'),
      source('packages/open-science/index.mjs'),
      source('src/shared/task-api.ts'),
      source('src/main/notebook/local-rpc-server.ts')
    ])

    expect(cliSource).toContain('--approval-profile <profile>')
    expect(cliSource).toContain("event.type === 'permission.requested'")
    expect(cliSource).not.toMatch(/--(?:specialist|compute|permission-grant)\b/)
    expect(taskContractSource).toContain('permissionProfile?: PermissionProfileId')
    expect(taskContractSource).not.toMatch(/\b(?:specialist|compute|permissionGrant)\w*\??:/i)

    const sdkClass = sdkSource.slice(
      sdkSource.indexOf('export class OpenScienceClient'),
      sdkSource.indexOf('export const connectToOpenScience')
    )
    const sdkMethods = [...sdkClass.matchAll(/^ {2}(?:async )?([a-zA-Z][a-zA-Z0-9_]*)\(/gm)].map(
      ([, method]) => method
    )
    expect(sdkMethods).toEqual([
      'constructor',
      'health',
      'listProjects',
      'createProject',
      'listSessions',
      'getSession',
      'startRun',
      'getRun',
      'waitForRun',
      'listArtifacts',
      'downloadArtifact',
      'events',
      'request',
      'throwResponseError'
    ])

    expect(localRpcSource).toContain(
      "const CONTROL_RPC_METHODS = new Set(['mcpCall', 'computeCall', 'agentsCall'])"
    )
    const computeBlock = localRpcSource.slice(
      localRpcSource.indexOf("if (method === 'computeCall')"),
      localRpcSource.indexOf('// agentsCall:')
    )
    expect([...computeBlock.matchAll(/if \(op === '([^']+)'\)/g)].map(([, op]) => op)).toEqual([
      'call_command',
      'list',
      'details',
      'download',
      'submit_job',
      'job_status',
      'job_result',
      'list_compute',
      'set_concurrency_limit',
      'concurrency_status'
    ])
    expect(localRpcSource).toContain('session-bound RPC capability')
    expect(computeBlock).not.toMatch(/\b(?:create|delete|probe|reveal_in_folder|bookmarks)\b/)
  })

  it('keeps projectFiles.searchArtifacts on Electron and both Web locations only', async () => {
    expect(WEB_INVOKE_CHANNELS['projectFiles.searchArtifacts']).toBe(
      'project-files:search-artifacts'
    )
    expect(isWebRpcChannel('project-files:search-artifacts')).toBe(true)
    expect(REMOTE_LOCAL_ONLY_RPC_CHANNELS.has('project-files:search-artifacts')).toBe(false)

    const [preloadSource, taskContractSource, sdkSource, localRpcSource] = await Promise.all([
      source('src/preload/index.ts'),
      source('src/shared/task-api.ts'),
      source('packages/open-science/index.mjs'),
      source('src/main/notebook/local-rpc-server.ts')
    ])
    expect(preloadSource).toMatch(
      /searchArtifacts: \(request\) =>\s+ipcRenderer\.invoke\(\s*'project-files:search-artifacts',\s*request\s*\)/
    )
    expect(taskContractSource).not.toContain('searchArtifacts')
    expect(sdkSource).not.toContain('searchArtifacts')
    expect(localRpcSource).not.toContain('searchArtifacts')
  })

  it('passes terminal ACP metadata through Web and Task projections without recomputation', () => {
    const payload: AcpRuntimeEvent = {
      id: 'terminal-1',
      timestamp: 1_700_000_000_123,
      kind: 'stop',
      level: 'info',
      sessionId: 'session-1',
      promptMessageId: 'prompt-1',
      terminalOutput: 'complete',
      terminalExitCode: 0,
      turnUsage: {
        inputTokens: 17,
        cacheTokens: 5,
        cachedReadTokens: 3,
        cachedWriteTokens: 2,
        outputTokens: 9,
        turnCount: 4
      },
      raw: { providerSessionId: 'provider-session' }
    }
    const event: ApplicationEvent<'acp:event'> = { channel: 'acp:event', payload }

    expect(projectTaskRuntimeEvent(event)).toBe(payload)
    expect(projectPublicTaskEvent(event)).toEqual({ type: 'run.event', data: payload })
    const webEvent = projectWebRendererEvent(event)
    expect(webEvent).toMatchObject({ protocolVersion: 1, channel: 'acp:event' })
    expect(webEvent?.payload).toBe(payload)
  })
})
